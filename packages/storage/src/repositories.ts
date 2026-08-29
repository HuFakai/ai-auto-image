import { and, eq, inArray, sql } from "drizzle-orm";
import {
  JOB_TERMINAL_STATUSES,
  type JobStatus,
  type ProviderErrorCategory,
} from "@aai/shared-schemas";
import type { Db, DbClient } from "./database";
import {
  newAssetId,
  newAssetRelationId,
  newAttemptId,
  newBrandKitId,
  newChannelId,
  newJobEventId,
  newJobId,
  newNodeRunId,
  newProjectId,
  newPromptVersionId,
  newRevisionId,
  newRunId,
  newSessionId,
  newUsageId,
  newUserId,
} from "./ids";
import {
  assetRelations,
  assets,
  brandKits,
  channels,
  jobEvents,
  jobs,
  nodeRuns,
  projects,
  promptVersions,
  providerAttempts,
  providerUsages,
  revisions,
  sessions,
  users,
  workflowRuns,
} from "./schema";

const now = () => Date.now();

/** 按主键/唯一键取单行：统一 limit(1) + rows[0]（SQLite 的 .get() 已随方言退役） */
async function one<TRow>(query: Promise<TRow[]>): Promise<TRow | undefined> {
  const rows = await query;
  return rows[0];
}

/* ── Projects ─────────────────────────────────────────────────── */

export interface CreateProjectInput {
  title: string;
  /** 归属用户；测试/旧数据可省略（null 归管理员可见集合） */
  userId?: string | undefined;
}

export class ProjectRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async create(input: CreateProjectInput) {
    const id = newProjectId();
    const ts = now();
    await this.client
      .insert(projects)
      .values({ id, title: input.title, userId: input.userId ?? null, createdAt: ts, updatedAt: ts });
    return this.require(id);
  }

  async require(id: string) {
    const row = await one(
      this.client.select().from(projects).where(eq(projects.id, id)).limit(1),
    );
    if (!row) throw new Error(`project not found: ${id}`);
    return row;
  }
}

/* ── Workflow runs & node runs ────────────────────────────────── */

export interface CreateRunInputRow {
  projectId: string;
  inputJson: string;
  /** 冗余归属（与 project 一致），用于行级过滤 */
  userId?: string | undefined;
}

export class RunRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async create(input: CreateRunInputRow) {
    const id = newRunId();
    const ts = now();
    await this.client
      .insert(workflowRuns)
      .values({ id, projectId: input.projectId, userId: input.userId ?? null, inputJson: input.inputJson, createdAt: ts, updatedAt: ts });
    return this.require(id);
  }

  async require(id: string) {
    const row = await one(
      this.client.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1),
    );
    if (!row) throw new Error(`workflow run not found: ${id}`);
    return row;
  }

  async list(limit = 50) {
    return this.client
      .select()
      .from(workflowRuns)
      .orderBy(sql`${workflowRuns.createdAt} DESC`)
      .limit(limit);
  }

  /** 按用户过滤的运行列表；userId 为 null 时返回全部（管理员视图） */
  async listForUser(userId: string | null, limit = 50) {
    const query = this.client.select().from(workflowRuns);
    const filtered = userId
      ? query.where(eq(workflowRuns.userId, userId))
      : query;
    return filtered.orderBy(sql`${workflowRuns.createdAt} DESC`).limit(limit);
  }

  async updateStatus(id: string, status: string, extra: { errorSummary?: string } = {}) {
    const patch: Record<string, unknown> = { status, updatedAt: now() };
    if (status === "running" && !(await this.require(id)).startedAt) patch.startedAt = now();
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      patch.finishedAt = now();
    }
    if (extra.errorSummary) patch.errorSummary = extra.errorSummary;
    await this.client.update(workflowRuns).set(patch).where(eq(workflowRuns.id, id));
  }

  async setSnapshot(id: string, snapshotJson: string) {
    await this.client
      .update(workflowRuns)
      .set({ snapshotJson, updatedAt: now() })
      .where(eq(workflowRuns.id, id));
  }

  /* Node runs */

  async createNodeRun(runId: string, nodeName: string) {
    const id = newNodeRunId();
    await this.client.insert(nodeRuns).values({ id, runId, nodeName });
    return this.requireNode(id);
  }

  async requireNode(id: string) {
    const row = await one(this.client.select().from(nodeRuns).where(eq(nodeRuns.id, id)).limit(1));
    if (!row) throw new Error(`node run not found: ${id}`);
    return row;
  }

  async listNodeRuns(runId: string) {
    return this.client
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.runId, runId))
      .orderBy(sql`${nodeRuns.startedAt} ASC`);
  }

  async startNode(id: string, extra: { routeId?: string; model?: string; promptVersionId?: string } = {}) {
    const node = await this.requireNode(id);
    await this.client
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
      .where(eq(nodeRuns.id, id));
  }

  async succeedNode(
    id: string,
    extra: {
      outputRef?: string;
      promptTokens?: number;
      completionTokens?: number;
      images?: number;
      costUsd?: number;
      /** 实际使用的模型（多路由回退后与 startNode 记录的首选可能不同） */
      model?: string;
    } = {},
  ) {
    await this.client
      .update(nodeRuns)
      .set({
        status: "succeeded",
        finishedAt: now(),
        outputRef: extra.outputRef ?? null,
        promptTokens: extra.promptTokens ?? 0,
        completionTokens: extra.completionTokens ?? 0,
        images: extra.images ?? 0,
        costUsd: extra.costUsd ?? null,
        ...(extra.model ? { model: extra.model } : {}),
      })
      .where(eq(nodeRuns.id, id));
  }

  /** 覆写节点输出（例如返修后同步 Storyboard 文案） */
  async setNodeOutput(id: string, outputRef: string) {
    await this.client.update(nodeRuns).set({ outputRef }).where(eq(nodeRuns.id, id));
  }

  async failNode(id: string, category: ProviderErrorCategory | "internal", summary: string) {
    await this.client
      .update(nodeRuns)
      .set({ status: "failed", finishedAt: now(), errorCategory: category, errorSummary: summary })
      .where(eq(nodeRuns.id, id));
  }

  async setReview(id: string, status: "pending" | "approved" | "rejected", note?: string) {
    await this.client
      .update(workflowRuns)
      .set({ reviewStatus: status, reviewNote: note ?? null, reviewedAt: now(), updatedAt: now() })
      .where(eq(workflowRuns.id, id));
    return this.require(id);
  }

  /** 汇总一次 Run 的费用与用量 */
  async runTotals(runId: string) {
    const row = await one(
      this.client
        .select({
          promptTokens: sql<string>`coalesce(sum(${nodeRuns.promptTokens}), 0)`,
          completionTokens: sql<string>`coalesce(sum(${nodeRuns.completionTokens}), 0)`,
          images: sql<string>`coalesce(sum(${nodeRuns.images}), 0)`,
          costUsd: sql<string>`coalesce(sum(${nodeRuns.costUsd}), 0)`,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.runId, runId))
        .limit(1),
    );
    // PG 聚合（bigint/numeric）经驱动返回 string，统一在 JS 层转数字
    const promptTokens = Number(row?.promptTokens ?? 0);
    const completionTokens = Number(row?.completionTokens ?? 0);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      images: Number(row?.images ?? 0),
      costUsd: Number(row?.costUsd ?? 0),
    };
  }
}

/* ── Prompt versions ──────────────────────────────────────────── */

export class PromptRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async ensureVersion(nodeName: string, template: string) {
    const existing = await one(
      this.client
        .select()
        .from(promptVersions)
        .where(and(eq(promptVersions.nodeName, nodeName), eq(promptVersions.template, template)))
        .limit(1),
    );
    if (existing) return existing;

    const maxRow = await one(
      this.client
        .select({ maxVersion: sql<string | null>`max(${promptVersions.version})` })
        .from(promptVersions)
        .where(eq(promptVersions.nodeName, nodeName))
        .limit(1),
    );
    const nextVersion = Number(maxRow?.maxVersion ?? 0) + 1;
    const id = newPromptVersionId();
    await this.client
      .insert(promptVersions)
      .values({ id, nodeName, version: nextVersion, template, createdAt: now() });
    const created = await one(
      this.client.select().from(promptVersions).where(eq(promptVersions.id, id)).limit(1),
    );
    if (!created) throw new Error(`prompt version not found: ${id}`);
    return created;
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
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async create(input: CreateAssetInput) {
    const id = newAssetId();
    await this.client
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
      });
    return this.require(id);
  }

  async require(id: string) {
    const row = await one(this.client.select().from(assets).where(eq(assets.id, id)).limit(1));
    if (!row) throw new Error(`asset not found: ${id}`);
    return row;
  }

  async listByRun(runId: string) {
    return this.client
      .select()
      .from(assets)
      .where(eq(assets.runId, runId))
      .orderBy(sql`${assets.createdAt} ASC`);
  }

  /** 指定 Run 某页的当前资产（未被替代的最新一张，kind 为 generated/composite） */
  async latestForPage(runId: string, pageIndex: number) {
    return one(
      this.client
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.runId, runId),
            eq(assets.pageIndex, pageIndex),
            sql`${assets.supersededAt} IS NULL`,
          ),
        )
        .orderBy(sql`${assets.createdAt} DESC`)
        .limit(1),
    );
  }

  /** 该页历史版本数（用于新文件命名 v{n}） */
  async pageVersionCount(runId: string, pageIndex: number): Promise<number> {
    const row = await one(
      this.client
        .select({ n: sql<string>`count(*)` })
        .from(assets)
        .where(and(eq(assets.runId, runId), eq(assets.pageIndex, pageIndex)))
        .limit(1),
    );
    return Number(row?.n ?? 0);
  }

  /** 整页废弃：该页所有未替代资产标记 superseded */
  async supersedePage(runId: string, pageIndex: number): Promise<void> {
    await this.client
      .update(assets)
      .set({ supersededAt: now() })
      .where(
        and(
          eq(assets.runId, runId),
          eq(assets.pageIndex, pageIndex),
          sql`${assets.supersededAt} IS NULL`,
        ),
      );
  }

  async linkRelation(assetId: string, relatedAssetId: string, relation: string) {
    await this.client.insert(assetRelations).values({
      id: newAssetRelationId(),
      assetId,
      relatedAssetId,
      relation,
      createdAt: now(),
    });
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
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  /** 某 Run 实际调用过的模型（按首次调用顺序去重，供生成信息展示） */
  async listUsedModels(runId: string): Promise<Array<{ routeId: string; model: string }>> {
    const rows = await this.client
      .select({ routeId: providerAttempts.routeId, model: providerAttempts.model })
      .from(providerAttempts)
      .where(eq(providerAttempts.runId, runId))
      .orderBy(sql`${providerAttempts.startedAt} ASC`);
    const seen = new Set<string>();
    const out: Array<{ routeId: string; model: string }> = [];
    for (const row of rows) {
      if (!row.model) continue;
      const key = `${row.routeId}:${row.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ routeId: row.routeId, model: row.model });
    }
    return out;
  }

  async recordAttempt(input: RecordAttemptInput) {
    const finishedAt = input.finishedAt ?? now();
    await this.client
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
      });
  }

  async recordUsage(input: {
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
    await this.client
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
      });
  }
}

/* ── Jobs ─────────────────────────────────────────────────────── */

export interface CreateJobInput {
  kind: string;
  runId?: string | undefined;
  idempotencyKey?: string | undefined;
  maxAttempts?: number;
  payloadJson?: string | undefined;
}

export class JobRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  /**
   * 幂等创建：同 key 且未取消的任务直接复用（借鉴 TaskManager.create_task）。
   * 显式取消被视为用户放弃本次尝试，允许同 key 重建。
   */
  async createOrReuse(input: CreateJobInput) {
    if (input.idempotencyKey) {
      const existing = await one(
        this.client
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.idempotencyKey, input.idempotencyKey),
              eq(jobs.kind, input.kind),
              sql`${jobs.status} != 'cancelled'`,
            ),
          )
          .limit(1),
      );
      if (existing) return { job: existing, reused: true };
    }
    const id = newJobId();
    const ts = now();
    await this.client
      .insert(jobs)
      .values({
        id,
        kind: input.kind,
        runId: input.runId ?? null,
        status: "queued",
        payloadJson: input.payloadJson ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        maxAttempts: input.maxAttempts ?? 3,
        lastProgressAt: ts,
        createdAt: ts,
        updatedAt: ts,
      });
    return { job: await this.require(id), reused: false };
  }

  async require(id: string) {
    const row = await one(this.client.select().from(jobs).where(eq(jobs.id, id)).limit(1));
    if (!row) throw new Error(`job not found: ${id}`);
    return row;
  }

  /** 取出可执行任务：queued、retry_waiting，或租约过期的 running（进程崩溃遗留） */
  async claimNext(holder: string, leaseMs: number) {
    const ts = now();
    const candidate = await one(
      this.client
        .select()
        .from(jobs)
        .where(
          sql`${jobs.status} IN ('queued', 'retry_waiting')
            OR (${jobs.status} = 'running' AND (${jobs.leaseExpiresAt} IS NULL OR ${jobs.leaseExpiresAt} < ${ts}))`,
        )
        .orderBy(sql`${jobs.createdAt} ASC`)
        .limit(1),
    );
    if (!candidate) return null;

    const recovered = candidate.status === "running";
    const updated = await this.client
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
      // returning 保证乐观抢占：已被其他持有者改走时返回空
      .where(and(eq(jobs.id, candidate.id), sql`${jobs.status} = ${candidate.status}`))
      .returning({ id: jobs.id });
    if (updated.length === 0) return null;

    const job = await this.require(candidate.id);
    await this.appendEvent(job.id, recovered ? "recovered" : "claimed", `holder=${holder}`);
    return job;
  }

  async renewLease(id: string, holder: string, leaseMs: number) {
    await this.client
      .update(jobs)
      .set({ leaseExpiresAt: now() + leaseMs, lastProgressAt: now(), updatedAt: now() })
      .where(and(eq(jobs.id, id), eq(jobs.leaseHolder, holder)));
  }

  /** 状态迁移只允许合法转换，终态不可再变更 */
  async updateStatus(id: string, status: JobStatus, extra: { lastError?: string } = {}) {
    const job = await this.require(id);
    if (JOB_TERMINAL_STATUSES.has(job.status as JobStatus)) return job;
    await this.client
      .update(jobs)
      .set({
        status,
        lastError: extra.lastError ?? job.lastError,
        updatedAt: now(),
      })
      .where(eq(jobs.id, id));
    return this.require(id);
  }

  /** watchdog：先持久化终态，再由调用方取消执行中的异步任务 */
  async failStalled(stallMs: number) {
    const ts = now();
    const stalled = await this.client
      .select()
      .from(jobs)
      .where(
        sql`${jobs.status} = 'running' AND ${jobs.lastProgressAt} IS NOT NULL AND ${jobs.lastProgressAt} < ${ts - stallMs}`,
      );
    for (const job of stalled) {
      await this.client
        .update(jobs)
        .set({
          status: job.attempts < job.maxAttempts ? "retry_waiting" : "failed",
          lastError: "stalled: no progress within timeout",
          updatedAt: ts,
        })
        .where(eq(jobs.id, job.id));
      await this.appendEvent(job.id, "stalled", "no progress within timeout");
    }
    return stalled;
  }

  async list(limit = 100) {
    return this.client.select().from(jobs).orderBy(sql`${jobs.createdAt} DESC`).limit(limit);
  }

  async listByStatus(statuses: JobStatus[]) {
    return this.client.select().from(jobs).where(inArray(jobs.status, [...statuses]));
  }

  async appendEvent(jobId: string, event: string, detail?: string) {
    await this.client
      .insert(jobEvents)
      .values({ id: newJobEventId(), jobId, event, detail: detail ?? null, createdAt: now() });
  }

  async listEvents(jobId: string) {
    return this.client
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .orderBy(sql`${jobEvents.createdAt} ASC`);
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
  imageEditSupport?: number;
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
  imageEditSupport?: number;
  lastTestOk?: number | null;
  lastTestAt?: number | null;
  lastTestDetail?: string | null;
}

export class ChannelRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async create(input: CreateChannelRow) {
    const id = newChannelId();
    const ts = now();
    await this.client
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
        imageEditSupport: input.imageEditSupport ?? 0,
        createdAt: ts,
        updatedAt: ts,
      });
    return this.require(id);
  }

  async require(id: string) {
    const row = await one(this.client.select().from(channels).where(eq(channels.id, id)).limit(1));
    if (!row) throw new Error(`channel not found: ${id}`);
    return row;
  }

  async list() {
    return this.client.select().from(channels).orderBy(sql`${channels.sortOrder} ASC`);
  }

  async count(): Promise<number> {
    const row = await one(
      this.client.select({ n: sql<string>`count(*)` }).from(channels).limit(1),
    );
    return Number(row?.n ?? 0);
  }

  async update(id: string, patch: UpdateChannelRow) {
    await this.client
      .update(channels)
      .set({ ...patch, updatedAt: now() })
      .where(eq(channels.id, id));
    return this.require(id);
  }

  async delete(id: string): Promise<void> {
    await this.client.delete(channels).where(eq(channels.id, id));
  }

  /** 重排：按传入 id 顺序重写 sortOrder（单写者场景逐条提交，两方言事务语义不一故不再包事务） */
  async reorder(orderedIds: string[]): Promise<void> {
    const ts = now();
    let index = 0;
    for (const id of orderedIds) {
      await this.client
        .update(channels)
        .set({ sortOrder: index + 1, updatedAt: ts })
        .where(eq(channels.id, id));
      index += 1;
    }
  }
}


/* ── Revisions（单页返修版本链）────────────────────────────────── */

export class RevisionRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async create(input: {
    runId: string;
    pageIndex: number;
    kind: string;
    payloadJson?: string | undefined;
    assetId?: string | undefined;
  }) {
    const id = newRevisionId();
    await this.client
      .insert(revisions)
      .values({
        id,
        runId: input.runId,
        pageIndex: input.pageIndex,
        kind: input.kind,
        payloadJson: input.payloadJson ?? null,
        assetId: input.assetId ?? null,
        createdAt: now(),
      });
    return this.require(id);
  }

  async require(id: string) {
    const row = await one(this.client.select().from(revisions).where(eq(revisions.id, id)).limit(1));
    if (!row) throw new Error(`revision not found: ${id}`);
    return row;
  }

  async listByPage(runId: string, pageIndex: number) {
    return this.client
      .select()
      .from(revisions)
      .where(and(eq(revisions.runId, runId), eq(revisions.pageIndex, pageIndex)))
      .orderBy(sql`${revisions.createdAt} ASC`);
  }
}

/* ── Brand Kits ───────────────────────────────────────────────── */

export interface BrandKitRow {
  name: string;
  themeId: string;
  styleKeywords: string[];
  negativeKeywords: string[];
  logoAssetId?: string | null;
  builtIn?: number;
}

export class BrandKitRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async create(input: BrandKitRow) {
    const id = newBrandKitId();
    const ts = now();
    await this.client
      .insert(brandKits)
      .values({
        id,
        name: input.name,
        themeId: input.themeId,
        styleKeywordsJson: JSON.stringify(input.styleKeywords),
        negativeKeywordsJson: JSON.stringify(input.negativeKeywords),
        logoAssetId: input.logoAssetId ?? null,
        builtIn: input.builtIn ?? 0,
        createdAt: ts,
        updatedAt: ts,
      });
    return this.require(id);
  }

  async require(id: string) {
    const row = await one(this.client.select().from(brandKits).where(eq(brandKits.id, id)).limit(1));
    if (!row) throw new Error(`brand kit not found: ${id}`);
    return row;
  }

  async list() {
    return this.client.select().from(brandKits).orderBy(sql`${brandKits.createdAt} ASC`);
  }

  async count(): Promise<number> {
    const row = await one(
      this.client.select({ n: sql<string>`count(*)` }).from(brandKits).limit(1),
    );
    return Number(row?.n ?? 0);
  }

  async update(id: string, patch: Partial<BrandKitRow>) {
    const set: Record<string, unknown> = { updatedAt: now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.themeId !== undefined) set.themeId = patch.themeId;
    if (patch.styleKeywords !== undefined) set.styleKeywordsJson = JSON.stringify(patch.styleKeywords);
    if (patch.negativeKeywords !== undefined) set.negativeKeywordsJson = JSON.stringify(patch.negativeKeywords);
    if (patch.logoAssetId !== undefined) set.logoAssetId = patch.logoAssetId;
    await this.client.update(brandKits).set(set).where(eq(brandKits.id, id));
    return this.require(id);
  }

  async delete(id: string): Promise<void> {
    await this.client.delete(brandKits).where(eq(brandKits.id, id));
  }

  /** 首次启动播种六套内置主题（幂等：仅在表为空时） */
  async seedBuiltIns(): Promise<number> {
    if ((await this.count()) > 0) return 0;
    const built: Array<[string, string, string[]]> = [
      ["暗房工作室", "darkroom", ["深色背景", "琥珀色点缀", "胶片质感"]],
      ["纸感极简", "paper_minimal", ["米白纸底", "大量留白", "细线分隔"]],
      ["高对比营销", "high_contrast", ["纯黑背景", "高饱和强调色", "大字冲击"]],
      ["莫兰迪生活", "morandi", ["低饱和灰调", "柔和光线", "生活场景"]],
      ["科技深色", "tech_dark", ["深蓝科技感", "发光线条", "未来感"]],
      ["图书纸张", "book_paper", ["暖纸质感", "书卷气", "柔和阴影"]],
    ];
    for (const [name, themeId, keywords] of built) {
      await this.create({ name, themeId, styleKeywords: keywords, negativeKeywords: [], builtIn: 1 });
    }
    return built.length;
  }
}

/* ── Users & Sessions（账号密码登录；auth_provider 预留微信小程序扫码）── */

export interface CreateUserInput {
  username: string;
  /** auth_provider=password 时必填（scrypt 格式）；第三方登录为 null */
  passwordHash?: string | null;
  role: "admin" | "user";
  authProvider?: "password" | "wechat_mp";
  providerSubject?: string | null;
}

export class UserRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async create(input: CreateUserInput) {
    const id = newUserId();
    const ts = now();
    await this.client.insert(users).values({
      id,
      username: input.username,
      passwordHash: input.passwordHash ?? null,
      role: input.role,
      authProvider: input.authProvider ?? "password",
      providerSubject: input.providerSubject ?? null,
      createdAt: ts,
      updatedAt: ts,
    });
    return this.require(id);
  }

  async require(id: string) {
    const row = await one(this.client.select().from(users).where(eq(users.id, id)).limit(1));
    if (!row) throw new Error(`user not found: ${id}`);
    return row;
  }

  async findByUsername(username: string) {
    return one(this.client.select().from(users).where(eq(users.username, username)).limit(1));
  }

  async findByProviderSubject(authProvider: string, subject: string) {
    return one(
      this.client
        .select()
        .from(users)
        .where(and(eq(users.authProvider, authProvider), eq(users.providerSubject, subject)))
        .limit(1),
    );
  }

  async count(): Promise<number> {
    const row = await one(this.client.select({ n: sql<string>`count(*)` }).from(users).limit(1));
    return Number(row?.n ?? 0);
  }

  async updateStatus(id: string, status: "active" | "disabled") {
    await this.client.update(users).set({ status, updatedAt: now() }).where(eq(users.id, id));
    return this.require(id);
  }
}

export interface CreateSessionInput {
  userId: string;
  /** 随机 token 的 SHA-256 摘要（明文 token 只存 cookie） */
  tokenHash: string;
  authProvider?: string;
  expiresAt: number;
}

export class SessionRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async create(input: CreateSessionInput) {
    const id = newSessionId();
    await this.client.insert(sessions).values({
      id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      authProvider: input.authProvider ?? "password",
      createdAt: now(),
      expiresAt: input.expiresAt,
    });
    return id;
  }

  /** 按 token 摘要取会话；过期返回 null（并顺带清理） */
  async findValidByTokenHash(tokenHash: string) {
    const row = await one(
      this.client.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1),
    );
    if (!row) return null;
    if (row.expiresAt < now()) {
      await this.delete(row.id);
      return null;
    }
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.client.delete(sessions).where(eq(sessions.id, id));
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.client.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.client.delete(sessions).where(eq(sessions.userId, userId));
  }

  /** 清理全部过期会话（可定期调用） */
  async deleteExpired(): Promise<void> {
    await this.client.delete(sessions).where(sql`${sessions.expiresAt} < ${now()}`);
  }
}
