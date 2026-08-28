import type { NodeStatus, WorkflowStatus } from "@aai/shared-schemas";
import { backoffDelay, sleep } from "@aai/ai-core";

// ---------------------------------------------------------------------------
// Ports — implemented by the app layer (SQLite today, BullMQ/PG later).
// ---------------------------------------------------------------------------

export interface NodeRunRecord {
  id: string;
  runId: string;
  nodeKey: string;
  kind: string;
  status: NodeStatus;
  attempt: number;
  inputRef?: string;
  outputRef?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  startedAt?: string;
  finishedAt?: string;
  errorType?: string;
  errorSummary?: string;
}

export interface NodeRunPort {
  upsert(record: NodeRunRecord): Promise<void>;
  listByRun(runId: string): Promise<NodeRunRecord[]>;
  get(runId: string, nodeKey: string): Promise<NodeRunRecord | undefined>;
}

export interface JobRecord {
  id: string;
  kind: string;
  payload: unknown;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  maxAttempts: number;
  runId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobPort {
  enqueue(job: Omit<JobRecord, "status" | "attempts" | "createdAt" | "updatedAt"> & { status?: JobRecord["status"] }): Promise<JobRecord>;
  /** Atomically claim the next queued job (runs inside a short transaction). */
  claim(next: (job: JobRecord) => Promise<void>): Promise<JobRecord | undefined>;
  markSucceeded(id: string): Promise<void>;
  markFailed(id: string, error: string, retryable: boolean): Promise<void>;
  /** Jobs stuck in `running` from a previous process (crash recovery). */
  recoverStale(staleSeconds: number): Promise<number>;
  cancel(id: string): Promise<void>;
}

export interface RunStatusPort {
  setStatus(runId: string, status: WorkflowStatus): Promise<void>;
}

export type NodeContext = {
  runId: string;
  projectId: string;
  nodeKey: string;
  attempt: number;
  /** Shared blackboard across nodes of one run (outputs keyed by nodeKey). */
  outputs: Map<string, unknown>;
  inputs: Map<string, unknown>;
  signal: AbortSignal;
  log: (message: string, extra?: Record<string, unknown>) => void;
};

export type NodeHandler = (ctx: NodeContext) => Promise<unknown>;

export interface RunRequest {
  runId: string;
  projectId: string;
  /** Ordered node specs; each maps to a handler by kind. */
  nodes: Array<{ key: string; kind: string; config?: Record<string, unknown> }>;
  /** Initial blackboard entries (parsed input etc). */
  seed?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ExecutorDeps {
  nodeRuns: NodeRunPort;
  runStatus: RunStatusPort;
  handlers: Record<string, NodeHandler>;
  maxAttemptsPerNode?: number;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Executor — sequential DAG with per-node retry. Already-succeeded nodes are
// never re-executed on resume, enabling partial re-runs after a crash.
// ---------------------------------------------------------------------------

export class WorkflowExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async run(req: RunRequest): Promise<{ status: WorkflowStatus; failedNode?: string; error?: string }> {
    const { nodeRuns, runStatus } = this.deps;
    const outputs = new Map<string, unknown>(Object.entries(req.seed ?? {}));
    const maxAttempts = this.deps.maxAttemptsPerNode ?? 3;
    let failedNode: string | undefined;
    let error: string | undefined;

    await runStatus.setStatus(req.runId, "GENERATING");

    for (const node of req.nodes) {
      if (req.signal?.aborted) {
        await runStatus.setStatus(req.runId, "CANCELLED");
        return { status: "CANCELLED", failedNode: node.key, error: "run cancelled" };
      }

      // Resume support: a previously succeeded node is skipped.
      const existing = await nodeRuns.get(req.runId, node.key);
      if (existing?.status === "SUCCEEDED" && existing.outputRef) {
        outputs.set(node.key, JSON.parse(existing.outputRef));
        continue;
      }

      const handler = this.deps.handlers[node.kind];
      if (!handler) {
        failedNode = node.key;
        error = `no handler for node kind ${node.kind}`;
        await nodeRuns.upsert({
          id: existing?.id ?? `${req.runId}:${node.key}`,
          runId: req.runId,
          nodeKey: node.key,
          kind: node.kind,
          status: "FAILED_FINAL",
          attempt: 1,
          errorType: "unsupported",
          errorSummary: error,
          finishedAt: new Date().toISOString(),
        });
        break;
      }

      let attempt = existing?.attempt ?? 0;
      let lastErr: unknown;
      let succeeded = false;

      while (attempt < maxAttempts && !succeeded) {
        attempt += 1;
        const startedAt = new Date().toISOString();
        await nodeRuns.upsert({
          id: existing?.id ?? `${req.runId}:${node.key}`,
          runId: req.runId,
          nodeKey: node.key,
          kind: node.kind,
          status: "RUNNING",
          attempt,
          startedAt,
        });
        try {
          const ctx: NodeContext = {
            runId: req.runId,
            projectId: req.projectId,
            nodeKey: node.key,
            attempt,
            outputs,
            inputs: new Map(Object.entries(node.config ?? {})),
            signal: req.signal ?? new AbortController().signal,
            log: this.deps.log ?? (() => {}),
          };
          const result = await handler(ctx);
          outputs.set(node.key, result);
          await nodeRuns.upsert({
            id: existing?.id ?? `${req.runId}:${node.key}`,
            runId: req.runId,
            nodeKey: node.key,
            kind: node.kind,
            status: "SUCCEEDED",
            attempt,
            outputRef: JSON.stringify(result ?? null),
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          succeeded = true;
        } catch (err) {
          lastErr = err;
          const retryable = isRetryable(err) && attempt < maxAttempts && !req.signal?.aborted;
          await nodeRuns.upsert({
            id: existing?.id ?? `${req.runId}:${node.key}`,
            runId: req.runId,
            nodeKey: node.key,
            kind: node.kind,
            status: retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL",
            attempt,
            errorType: err instanceof Error ? err.name : "unknown",
            errorSummary: err instanceof Error ? err.message.slice(0, 500) : String(err),
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          this.deps.log?.(`node ${node.key} attempt ${attempt} failed`, {
            error: err instanceof Error ? err.message : String(err),
            retryable,
          });
          if (retryable) {
            await sleep(backoffDelay(attempt), req.signal).catch(() => {});
          }
        }
      }

      if (!succeeded) {
        failedNode = node.key;
        error = lastErr instanceof Error ? lastErr.message : String(lastErr);
        break;
      }
    }

    const status: WorkflowStatus = failedNode ? "FAILED_RETRYABLE" : "REVIEWING";
    await runStatus.setStatus(req.runId, status);
    return { status, failedNode, error };
  }
}

function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object" && "retryable" in err) {
    return Boolean((err as { retryable?: boolean }).retryable);
  }
  return false;
}

// ---------------------------------------------------------------------------
// In-process bounded Job Runner over the jobs table.
// ---------------------------------------------------------------------------

export class InProcessJobRunner {
  private stopped = false;
  private activeRuns = new Set<string>();

  constructor(
    private readonly jobs: JobPort,
    private readonly exec: (job: JobRecord) => Promise<void>,
    private readonly opts: { concurrency?: number; pollIntervalMs?: number; staleSeconds?: number } = {}
  ) {}

  /** Recover jobs left running by a previous process, then start polling. */
  async start(): Promise<void> {
    const recovered = await this.jobs.recoverStale(this.opts.staleSeconds ?? 0);
    if (recovered > 0) {
      console.info(`[job-runner] recovered ${recovered} stale job(s) into queued state`);
    }
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  get activeCount(): number {
    return this.activeRuns.size;
  }

  private async loop(): Promise<void> {
    const concurrency = this.opts.concurrency ?? 1;
    while (!this.stopped) {
      try {
        if (this.activeRuns.size >= concurrency) {
          await sleep(this.opts.pollIntervalMs ?? 500);
          continue;
        }
        let claimed = false;
        await this.jobs.claim(async (job) => {
          claimed = true;
          const p = this.exec(job)
            .then(() => this.jobs.markSucceeded(job.id))
            .catch((err) => {
              const retryable =
                err && typeof err === "object" && "retryable" in err
                  ? Boolean((err as { retryable?: boolean }).retryable)
                  : false;
              return this.jobs.markFailed(job.id, err instanceof Error ? err.message : String(err), retryable);
            })
            .finally(() => this.activeRuns.delete(job.id));
          this.activeRuns.add(job.id);
        });
        if (!claimed) await sleep(this.opts.pollIntervalMs ?? 500);
      } catch (err) {
        console.error("[job-runner] loop error", err);
        await sleep(2000);
      }
    }
  }
}
