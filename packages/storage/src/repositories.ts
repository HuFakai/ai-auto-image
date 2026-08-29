import { and, eq, inArray, sql } from "drizzle-orm";
import {
  JOB_TERMINAL_STATUSES,
  type JobStatus,
  type ProviderErrorCategory,
} from "@aai/shared-schemas";
import type { Db } from "./database";
import {
  newAssetId,
  newAssetRelationId,
  newAttemptId,
  newChannelId,
  newJobEventId,
  newJobId,
  newNodeRunId,
  newProjectId,
  newPromptVersionId,
  newRunId,
  newUsageId,
} from "./ids";
import {
  assetRelations,
  assets,
  channels,
  jobEvents,
  jobs,
  nodeRuns,
  projects,
  promptVersions,
  providerAttempts,
  providerUsages,
  workflowRuns,
} from "./schema";

const now = () => Date.now();

/* ── Projects ─────────────────────────────────────────────────── */

export interface CreateProjectInput {
  title: string;
}

export class ProjectRepo {
  constructor(private readonly db: Db) {}

  create(input: CreateProjectInput) {
    const id = newProjectId();
    const ts = now();
    this.db.insert(projects).values({ id, title: input.title, createdAt: ts, updatedAt: ts }).run();
    return this.require(id);
  }

  require(id: string) {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw new Error(`project not found: ${id}`);
    return row;
  }
}

/* ── Workflow runs & node runs ────────────────────────────────── */

export interface CreateRunInputRow {
  projectId: string;
  inputJson: string;
}

export class RunRepo {
  constructor(private readonly db: Db) {}

  create(input: CreateRunInputRow) {
    const id = newRunId();
    const ts = now();
    this.db
      .insert(workflowRuns)
      .values({ id, projectId: input.projectId, inputJson: input.inputJson, createdAt: ts, updatedAt: ts })
      .run();
    return this.require(id);
  }

  require(id: string) {
    const row = this.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get();
    if (!row) throw new Error(`workflow run not found: ${id}`);
    return row;
  }

  list(limit = 50) {
    return this.db
      .select()
      .from(workflowRuns)
      .orderBy(sql`${workflowRuns.createdAt} DESC`)
      .limit(limit)
      .all();
  }

  updateStatus(id: string, status: string, extra: { errorSummary?: string } = {}) {
    const patch: Record<string, unknown> = { status, updatedAt: now() };
    if (status === "running" && !this.require(id).startedAt) patch.startedAt = now();
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      patch.finishedAt = now();
    }
    if (extra.errorSummary) patch.errorSummary = extra.errorSummary;
    this.db.update(workflowRuns).set(patch).where(eq(workflowRuns.id, id)).run();
  }

  setSnapshot(id: string, snapshotJson: string) {
    this.db
      .update(workflowRuns)
      .set({ snapshotJson, updatedAt: now() })
      .where(eq(workflowRuns.id, id))
      .run();
  }

  /* Node runs */

  createNodeRun(runId: string, nodeName: string) {
    const id = newNodeRunId();
    this.db.insert(nodeRuns).values({ id, runId, nodeName }).run();
    return this.requireNode(id);
  }

  requireNode(id: string) {
    const row = this.db.select().from(nodeRuns).where(eq(nodeRuns.id, id)).get();
    if (!row) throw new Error(`node run not found: ${id}`);
    return row;
  }

  listNodeRuns(runId: string) {
    return this.db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.runId, runId))
      .orderBy(sql`${nodeRuns.startedAt} ASC`)
      .all();
  }

  startNode(id: string, extra: { routeId?: string; model?: string; promptVersionId?: string } = {}) {
    const node = this.requireNode(id);
    this.db
      .update(nodeRuns)
      .set({
        status: "running",
        attempt: node.attempt + 1,
        startedAt: now(),
        finishedAt: null,
        errorCategory: null,
        errorSummary: null,
        routeId: extra.routeId ?? node.routeId,
        model: extra.model ?? node.model,
        promptVersionId: extra.promptVersionId ?? node.promptVersionId,
      })
      .where(eq(nodeRuns.id, id))
      .run();
  }

  succeedNode(
    id: string,
    extra: {
      outputRef?: string;
      promptTokens?: number;
      completionTokens?: number;
      images?: number;
      costUsd?: number;
    } = {},
  ) {
    this.db
      .update(nodeRuns)
      .set({
        status: "succeeded",
        finishedAt: now(),
        outputRef: extra.outputRef ?? null,
        promptTokens: extra.promptTokens ?? 0,
        completionTokens: extra.completionTokens ?? 0,
        images: extra.images ?? 0,
        costUsd: extra.costUsd ?? null,
      })
      .where(eq(nodeRuns.id, id))
      .run();
  }

  failNode(id: string, category: ProviderErrorCategory | "internal", summary: string) {
    this.db
      .update(nodeRuns)
      .set({ status: "failed", finishedAt: now(), errorCategory: category, errorSummary: summary })
      .where(eq(nodeRuns.id, id))
      .run();
  }

  /** 汇总一次 Run 的费用与用量 */
  runTotals(runId: string) {
    const row = this.db
      .select({
        promptTokens: sql<number>`coalesce(sum(${nodeRuns.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${nodeRuns.completionTokens}), 0)`,
        images: sql<number>`coalesce(sum(${nodeRuns.images}), 0)`,
        costUsd: sql<number>`coalesce(sum(${nodeRuns.costUsd}), 0)`,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.runId, runId))
      .get();
    const promptTokens = row?.promptTokens ?? 0;
    const completionTokens = row?.completionTokens ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      images: row?.images ?? 0,
      costUsd: row?.costUsd ?? 0,
    };
  }
}

/* ── Prompt versions ──────────────────────────────────────────── */

export class PromptRepo {
  constructor(private readonly db: Db) {}

  ensureVersion(nodeName: string, template: string) {
    const existing = this.db
      .select()
      .from(promptVersions)
      .where(and(eq(promptVersions.nodeName, nodeName), eq(promptVersions.template, template)))
      .get();
    if (existing) return existing;

    const maxRow = this.db
      .select({ maxVersion: sql<number | null>`max(${promptVersions.version})` })
      .from(promptVersions)
      .where(eq(promptVersions.nodeName, nodeName))
      .get();
    const nextVersion = (maxRow?.maxVersion ?? 0) + 1;
    const id = newPromptVersionId();
    this.db
      .insert(promptVersions)
      .values({ id, nodeName, version: nextVersion, template, createdAt: now() })
      .run();
    return this.db.select().from(promptVersions).where(eq(promptVersions.id, id)).get()!;
  }
}

/* ── Assets ───────────────────────────────────────────────────── */

export interface CreateAssetInput {
  runId?: string | undefined;
  nodeRunId?: string | undefined;
  pageIndex?: number | undefined;
  kind: string;
  filePath: string;
  mimeType?: string;
  width?: number | undefined;
  height?: number | undefined;
  bytes: number;
  checksum?: string | undefined;
  metadataJson?: string | undefined;
}

export class AssetRepo {
  constructor(private readonly db: Db) {}

  create(input: CreateAssetInput) {
    const id = newAssetId();
    this.db
      .insert(assets)
      .values({
        id,
        runId: input.runId ?? null,
        nodeRunId: input.nodeRunId ?? null,
        pageIndex: input.pageIndex ?? null,
        kind: input.kind,
        filePath: input.filePath,
        mimeType: input.mimeType ?? "image/png",
        width: input.width ?? null,
        height: input.height ?? null,
        bytes: input.bytes,
        checksum: input.checksum ?? null,
        metadataJson: input.metadataJson ?? null,
        createdAt: now(),
      })
      .run();
    return this.require(id);
  }

  require(id: string) {
    const row = this.db.select().from(assets).where(eq(assets.id, id)).get();
    if (!row) throw new Error(`asset not found: ${id}`);
    return row;
  }

  listByRun(runId: string) {
    return this.db
      .select()
      .from(assets)
      .where(eq(assets.runId, runId))
      .orderBy(sql`${assets.createdAt} ASC`)
      .all();
  }

  linkRelation(assetId: string, relatedAssetId: string, relation: string) {
    this.db
      .insert(assetRelations)
      .values({
        id: newAssetRelationId(),
        assetId,
        relatedAssetId,
        relation,
        createdAt: now(),
      })
      .run();
  }
}

/* ── Provider attempts & usages ───────────────────────────────── */

export interface RecordAttemptInput {
  runId?: string | undefined;
  nodeRunId?: string | undefined;
  routeId: string;
  kind: string;
  model?: string | undefined;
  attempt: number;
  statusCode?: number | undefined;
  errorCategory?: ProviderErrorCategory | undefined;
  errorSummary?: string | undefined;
  providerRequestId?: string | undefined;
  startedAt: number;
  finishedAt?: number | undefined;
}

export class ProviderRepo {
  constructor(private readonly db: Db) {}

  recordAttempt(input: RecordAttemptInput) {
    const finishedAt = input.finishedAt ?? now();
    this.db
      .insert(providerAttempts)
      .values({
        id: newAttemptId(),
        runId: input.runId ?? null,
        nodeRunId: input.nodeRunId ?? null,
        routeId: input.routeId,
        kind: input.kind,
        model: input.model ?? null,
        attempt: input.attempt,
        statusCode: input.statusCode ?? null,
        errorCategory: input.errorCategory ?? null,
        errorSummary: input.errorSummary ?? null,
        providerRequestId: input.providerRequestId ?? null,
        startedAt: input.startedAt,
        finishedAt,
        durationMs: finishedAt - input.startedAt,
      })
      .run();
  }

  recordUsage(input: {
    runId?: string | undefined;
    nodeRunId?: string | undefined;
    routeId: string;
    model?: string | undefined;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    images?: number;
    costUsd?: number | undefined;
  }) {
    this.db
      .insert(providerUsages)
      .values({
        id: newUsageId(),
        runId: input.runId ?? null,
        nodeRunId: input.nodeRunId ?? null,
        routeId: input.routeId,
        model: input.model ?? null,
        promptTokens: input.promptTokens ?? 0,
        completionTokens: input.completionTokens ?? 0,
        totalTokens: input.totalTokens ?? 0,
        images: input.images ?? 0,
        costUsd: input.costUsd ?? null,
        createdAt: now(),
      })
      .run();
  }
}

/* ── Jobs ─────────────────────────────────────────────────────── */

export interface CreateJobInput {
  kind: string;
  runId?: string | undefined;
  idempotencyKey?: string | undefined;
  maxAttempts?: number;
}

export class JobRepo {
  constructor(private readonly db: Db) {}

  /**
   * 幂等创建：同 key 且未取消的任务直接复用（借鉴 TaskManager.create_task）。
   * 显式取消被视为用户放弃本次尝试，允许同 key 重建。
   */
  createOrReuse(input: CreateJobInput) {
    if (input.idempotencyKey) {
      const existing = this.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.idempotencyKey, input.idempotencyKey),
            eq(jobs.kind, input.kind),
            sql`${jobs.status} != 'cancelled'`,
          ),
        )
        .get();
      if (existing) return { job: existing, reused: true };
    }
    const id = newJobId();
    const ts = now();
    this.db
      .insert(jobs)
      .values({
        id,
        kind: input.kind,
        runId: input.runId ?? null,
        status: "queued",
        idempotencyKey: input.idempotencyKey ?? null,
        maxAttempts: input.maxAttempts ?? 3,
        lastProgressAt: ts,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return { job: this.require(id), reused: false };
  }

  require(id: string) {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row) throw new Error(`job not found: ${id}`);
    return row;
  }

  /** 取出可执行任务：queued、retry_waiting，或租约过期的 running（进程崩溃遗留） */
  claimNext(holder: string, leaseMs: number) {
    const ts = now();
    const claimable = this.db
      .select()
      .from(jobs)
      .where(
        sql`${jobs.status} IN ('queued', 'retry_waiting')
            OR (${jobs.status} = 'running' AND (${jobs.leaseExpiresAt} IS NULL OR ${jobs.leaseExpiresAt} < ${ts}))`,
      )
      .orderBy(sql`${jobs.createdAt} ASC`)
      .limit(1)
      .all();
    const candidate = claimable[0];
    if (!candidate) return null;

    const recovered = candidate.status === "running";
    const updated = this.db
      .update(jobs)
      .set({
        status: "running",
        leaseHolder: holder,
        leaseExpiresAt: ts + leaseMs,
        attempts: candidate.attempts + 1,
        recoveries: recovered ? candidate.recoveries + 1 : candidate.recoveries,
        lastProgressAt: ts,
        updatedAt: ts,
      })
      .where(and(eq(jobs.id, candidate.id), sql`${jobs.status} = ${candidate.status}`))
      .run();
    if (updated.changes === 0) return null;

    const job = this.require(candidate.id);
    this.appendEvent(job.id, recovered ? "recovered" : "claimed", `holder=${holder}`);
    return job;
  }

  renewLease(id: string, holder: string, leaseMs: number) {
    this.db
      .update(jobs)
      .set({ leaseExpiresAt: now() + leaseMs, lastProgressAt: now(), updatedAt: now() })
      .where(and(eq(jobs.id, id), eq(jobs.leaseHolder, holder)))
      .run();
  }

  /** 状态迁移只允许合法转换，终态不可再变更 */
  updateStatus(id: string, status: JobStatus, extra: { lastError?: string } = {}) {
    const job = this.require(id);
    if (JOB_TERMINAL_STATUSES.has(job.status as JobStatus)) return job;
    this.db
      .update(jobs)
      .set({
        status,
        lastError: extra.lastError ?? job.lastError,
        updatedAt: now(),
      })
      .where(eq(jobs.id, id))
      .run();
    return this.require(id);
  }

  /** watchdog：先持久化终态，再由调用方取消执行中的异步任务 */
  failStalled(stallMs: number) {
    const ts = now();
    const stalled = this.db
      .select()
      .from(jobs)
      .where(
        sql`${jobs.status} = 'running' AND ${jobs.lastProgressAt} IS NOT NULL AND ${jobs.lastProgressAt} < ${ts - stallMs}`,
      )
      .all();
    for (const job of stalled) {
      this.db
        .update(jobs)
        .set({
          status: job.attempts < job.maxAttempts ? "retry_waiting" : "failed",
          lastError: "stalled: no progress within timeout",
          updatedAt: ts,
        })
        .where(eq(jobs.id, job.id))
        .run();
      this.appendEvent(job.id, "stalled", "no progress within timeout");
    }
    return stalled;
  }

  list(limit = 100) {
    return this.db
      .select()
      .from(jobs)
      .orderBy(sql`${jobs.createdAt} DESC`)
      .limit(limit)
      .all();
  }

  listByStatus(statuses: JobStatus[]) {
    return this.db.select().from(jobs).where(inArray(jobs.status, [...statuses])).all();
  }

  appendEvent(jobId: string, event: string, detail?: string) {
    this.db
      .insert(jobEvents)
      .values({ id: newJobEventId(), jobId, event, detail: detail ?? null, createdAt: now() })
      .run();
  }

  listEvents(jobId: string) {
    return this.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .orderBy(sql`${jobEvents.createdAt} ASC`)
      .all();
  }
}

/* ── Channels（模型渠道，密钥加密落库）────────────────────────── */

export interface CreateChannelRow {
  name: string;
  type: string;
  baseUrl: string;
  apiKeyEncrypted: string;
  apiKeyHint: string;
  textModel?: string | null;
  imageModel?: string | null;
  aspectRatioParam?: string;
  responseFormat?: string;
  resolution?: string | null;
  maxAttempts?: number;
  imageConcurrencyMax?: number | null;
}

export interface UpdateChannelRow {
  name?: string;
  baseUrl?: string;
  apiKeyEncrypted?: string;
  apiKeyHint?: string;
  textModel?: string | null;
  imageModel?: string | null;
  aspectRatioParam?: string;
  responseFormat?: string;
  resolution?: string | null;
  enabled?: number;
  maxAttempts?: number;
  imageConcurrencyMax?: number | null;
  lastTestOk?: number | null;
  lastTestAt?: number | null;
  lastTestDetail?: string | null;
}

export class ChannelRepo {
  constructor(private readonly db: Db) {}

  create(input: CreateChannelRow) {
    const id = newChannelId();
    const ts = now();
    this.db
      .insert(channels)
      .values({
        id,
        name: input.name,
        type: input.type,
        baseUrl: input.baseUrl,
        apiKeyEncrypted: input.apiKeyEncrypted,
        apiKeyHint: input.apiKeyHint,
        textModel: input.textModel ?? null,
        imageModel: input.imageModel ?? null,
        aspectRatioParam: input.aspectRatioParam ?? "aspect_ratio",
        responseFormat: input.responseFormat ?? "b64_json",
        resolution: input.resolution ?? null,
        enabled: 1,
        sortOrder: ts,
        maxAttempts: input.maxAttempts ?? 3,
        imageConcurrencyMax: input.imageConcurrencyMax ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return this.require(id);
  }

  require(id: string) {
    const row = this.db.select().from(channels).where(eq(channels.id, id)).get();
    if (!row) throw new Error(`channel not found: ${id}`);
    return row;
  }

  list() {
    return this.db
      .select()
      .from(channels)
      .orderBy(sql`${channels.sortOrder} ASC`)
      .all();
  }

  count(): number {
    const row = this.db.select({ n: sql<number>`count(*)` }).from(channels).get();
    return row?.n ?? 0;
  }

  update(id: string, patch: UpdateChannelRow) {
    this.db
      .update(channels)
      .set({ ...patch, updatedAt: now() })
      .where(eq(channels.id, id))
      .run();
    return this.require(id);
  }

  delete(id: string): void {
    this.db.delete(channels).where(eq(channels.id, id)).run();
  }

  /** 重排：按传入 id 顺序重写 sortOrder */
  reorder(orderedIds: string[]): void {
    const ts = now();
    this.db.transaction((tx) => {
      orderedIds.forEach((id, index) => {
        tx.update(channels).set({ sortOrder: index + 1, updatedAt: ts }).where(eq(channels.id, id)).run();
      });
    });
  }
}
