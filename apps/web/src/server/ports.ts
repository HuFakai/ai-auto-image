import { and, eq } from "drizzle-orm";
import { getDb, getSqlite } from "./db";
import { jobs, nodeRuns, workflowRuns } from "./db/schema";
import type { JobPort, JobRecord, NodeRunPort, NodeRunRecord, RunStatusPort } from "@aai/workflow-engine";
import type { WorkflowStatus } from "@aai/shared-schemas";

const toDate = (v: unknown): string => (typeof v === "string" ? v : new Date().toISOString());

// ---------------------------------------------------------------------------
// jobs table port — claim() runs inside a short SQLite transaction so multiple
// in-process workers never grab the same job. Same interface later maps to BullMQ.
// ---------------------------------------------------------------------------

export class SqliteJobPort implements JobPort {
  enqueue(
    job: Omit<JobRecord, "status" | "attempts" | "createdAt" | "updatedAt"> & { status?: JobRecord["status"] }
  ): Promise<JobRecord> {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const record = {
      id: job.id,
      kind: job.kind,
      payload: JSON.stringify(job.payload ?? {}),
      status: job.status ?? ("queued" as const),
      attempts: 0,
      maxAttempts: job.maxAttempts ?? 1,
      runId: job.runId ?? null,
      lastError: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      startedAt: null,
      finishedAt: null,
    };
    db.insert(jobs).values(record).run();
    return Promise.resolve(toJobRecord(record));
  }

  /** Claim loop is single-threaded in-process; the transaction guards multi-instance dev setups. */
  async claim(next: (job: JobRecord) => Promise<void>): Promise<JobRecord | undefined> {
    const sqlite = getSqlite();
    const claimTx = sqlite.transaction((): unknown => {
      const row = sqlite
        .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get() as Record<string, unknown> | undefined;
      if (!row) return undefined;
      sqlite
        .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), new Date().toISOString(), row.id as string);
      return row;
    });
    const row = claimTx() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record = toJobRecord(row);
    await next(record);
    return record;
  }

  async markSucceeded(id: string): Promise<void> {
    getDb()
      .update(jobs)
      .set({ status: "succeeded", finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id))
      .run();
  }

  async markFailed(id: string, error: string, retryable: boolean): Promise<void> {
    const db = getDb();
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return;
    const attempts = job.attempts;
    const shouldRetry = retryable && attempts < job.maxAttempts;
    db.update(jobs)
      .set({
        status: shouldRetry ? "queued" : "failed",
        lastError: error.slice(0, 1000),
        updatedAt: new Date().toISOString(),
        finishedAt: shouldRetry ? null : new Date().toISOString(),
      })
      .where(eq(jobs.id, id))
      .run();
  }

  async recoverStale(staleSeconds: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleSeconds * 1000).toISOString();
    const sqlite = getSqlite();
    const result = sqlite
      .prepare(
        "UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running' AND started_at < ?"
      )
      .run(new Date().toISOString(), cutoff);
    return result.changes;
  }

  async cancel(id: string): Promise<void> {
    getDb()
      .update(jobs)
      .set({ status: "cancelled", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() })
      .where(and(eq(jobs.id, id), eq(jobs.status, "queued")))
      .run();
  }
}

function toJobRecord(row: Record<string, unknown> | typeof jobs.$inferSelect): JobRecord {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    kind: r.kind as string,
    payload: JSON.parse((r.payload as string) ?? "{}"),
    status: r.status as JobRecord["status"],
    attempts: (r.attempts as number) ?? 0,
    maxAttempts: (r.maxAttempts as number) ?? 1,
    runId: (r.runId as string) ?? undefined,
    lastError: (r.lastError as string) ?? undefined,
    createdAt: toDate(r.createdAt ?? r.created_at),
    updatedAt: toDate(r.updatedAt ?? r.updated_at),
    startedAt: (r.startedAt ?? r.started_at) as string | undefined,
    finishedAt: (r.finishedAt ?? r.finished_at) as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// node_runs + workflow_runs ports
// ---------------------------------------------------------------------------

export class SqliteNodeRunPort implements NodeRunPort {
  async upsert(record: NodeRunRecord): Promise<void> {
    const db = getDb();
    const existing = db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.runId, record.runId), eq(nodeRuns.nodeKey, record.nodeKey)))
      .get();
    const values = {
      runId: record.runId,
      nodeKey: record.nodeKey,
      kind: record.kind,
      status: record.status,
      attempt: record.attempt,
      inputRef: record.inputRef ?? null,
      outputRef: record.outputRef ?? null,
      provider: record.provider ?? null,
      model: record.model ?? null,
      promptVersion: record.promptVersion ?? null,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      errorType: record.errorType ?? null,
      errorSummary: record.errorSummary ?? null,
    };
    if (existing) {
      db.update(nodeRuns).set(values).where(eq(nodeRuns.id, existing.id)).run();
    } else {
      db.insert(nodeRuns).values({ id: record.id, ...values }).run();
    }
  }

  async listByRun(runId: string): Promise<NodeRunRecord[]> {
    const rows = getDb().select().from(nodeRuns).where(eq(nodeRuns.runId, runId)).all();
    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      nodeKey: r.nodeKey,
      kind: r.kind,
      status: r.status as NodeRunRecord["status"],
      attempt: r.attempt,
      inputRef: r.inputRef ?? undefined,
      outputRef: r.outputRef ?? undefined,
      provider: r.provider ?? undefined,
      model: r.model ?? undefined,
      promptVersion: r.promptVersion ?? undefined,
      startedAt: r.startedAt ?? undefined,
      finishedAt: r.finishedAt ?? undefined,
      errorType: r.errorType ?? undefined,
      errorSummary: r.errorSummary ?? undefined,
    }));
  }

  async get(runId: string, nodeKey: string): Promise<NodeRunRecord | undefined> {
    const row = getDb()
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.runId, runId), eq(nodeRuns.nodeKey, nodeKey)))
      .get();
    if (!row) return undefined;
    return {
      id: row.id,
      runId: row.runId,
      nodeKey: row.nodeKey,
      kind: row.kind,
      status: row.status as NodeRunRecord["status"],
      attempt: row.attempt,
      inputRef: row.inputRef ?? undefined,
      outputRef: row.outputRef ?? undefined,
      provider: row.provider ?? undefined,
      model: row.model ?? undefined,
      promptVersion: row.promptVersion ?? undefined,
      startedAt: row.startedAt ?? undefined,
      finishedAt: row.finishedAt ?? undefined,
      errorType: row.errorType ?? undefined,
      errorSummary: row.errorSummary ?? undefined,
    };
  }
}

export class SqliteRunStatusPort implements RunStatusPort {
  async setStatus(runId: string, status: WorkflowStatus): Promise<void> {
    getDb()
      .update(workflowRuns)
      .set({
        status,
        finishedAt: ["REVIEWING", "COMPLETED", "CANCELLED", "FAILED_RETRYABLE", "FAILED_FINAL"].includes(status)
          ? new Date().toISOString()
          : null,
      })
      .where(eq(workflowRuns.id, runId))
      .run();

    const db = getDb();
    const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
    if (run && ["REVIEWING", "READY_TO_EXPORT"].includes(status)) {
      const { projects } = await import("./db/schema");
      db.update(projects).set({ status, updatedAt: new Date().toISOString() }).where(eq(projects.id, run.projectId)).run();
    }
  }
}
