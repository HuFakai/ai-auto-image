import { and, desc, eq, gte, inArray, like, ne, notInArray, sql } from "drizzle-orm";
import {
  JOB_TERMINAL_STATUSES,
  type JobStatus,
  type PaletteOverrides,
  type ProviderErrorCategory,
} from "@aai/shared-schemas";
import type { Db, DbClient } from "./database";
import {
  newAssetId,
  newAssetRelationId,
  newAttemptId,
  newBrandKitId,
  newChannelId,
  newChannelModelId,
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
  newPlanId,
  newPackageId,
  newOrderId,
  newWalletId,
  newSubscriptionId,
  newLedgerId,
} from "./ids";
import {
  assetRelations,
  assets,
  brandKits,
  channels,
  channelModels,
  creditLedger,
  creditPackages,
  jobEvents,
  jobs,
  nodeRuns,
  orders,
  paymentConfigs,
  plans,
  projects,
  promptVersions,
  providerAttempts,
  providerUsages,
  revisions,
  sessions,
  subscriptions,
  users,
  wallets,
  workflowRuns,
} from "./schema";

const now = () => Date.now();

/**
 * 顶层运行（workflow_runs）终态：succeeded/cancelled 不可被后续状态覆盖。
 * 注意：failed 不是终态 —— 两条流水线在页失败时都会把 run 置 failed，随后 Job 重试会
 * 再流转回 running → succeeded（见 pipeline.test.ts「retries only the failed page」）。
 */
const RUN_TERMINAL_STATUSES = ["succeeded", "cancelled"] as const;

/** 按主键/唯一键取单行：统一 limit(1) + rows[0]（SQLite 的 .get() 已随方言退役） */
async function one<TRow>(query: Promise<TRow[]>): Promise<TRow | undefined> {
  const rows = await query;
  return rows[0];
}

export interface PageResult<TRow> {
  items: TRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function normalizePage(page: number | undefined, pageSize: number | undefined): { page: number; pageSize: number } {
  return {
    page: Number.isInteger(page) && (page ?? 0) > 0 ? page! : 1,
    pageSize: Number.isInteger(pageSize) && (pageSize ?? 0) >= 10
      ? Math.min(pageSize!, 100)
      : 20,
  };
}

function toPageResult<TRow>(items: TRow[], total: number, page: number, pageSize: number): PageResult<TRow> {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
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

  /** 删除项目（级联删除其全部 run/节点/资产记录；媒体文件由调用方另行清理） */
  async delete(id: string): Promise<void> {
    await this.client.delete(projects).where(eq(projects.id, id));
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
  /** 节点成功且产生图片时触发（计费扣点等）；关键钩子异常必须阻断当前节点 */
  private readonly nodeSucceededHooks: Array<(event: { runId: string; nodeRunId: string; images: number; credits: number }) => Promise<void>> = [];

  /** 注册「节点成功产出图片」回调（进程内单次注册，如计费服务） */
  onNodeSucceeded(hook: (event: { runId: string; nodeRunId: string; images: number; credits: number }) => Promise<void>): void {
    this.nodeSucceededHooks.push(hook);
  }

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

  /** 返回 Run 对应的作品标题，供点数流水生成稳定的展示标题快照。 */
  async projectTitle(runId: string): Promise<string | null> {
    const row = await one(
      this.client
        .select({ title: projects.title })
        .from(workflowRuns)
        .innerJoin(projects, eq(workflowRuns.projectId, projects.id))
        .where(eq(workflowRuns.id, runId))
        .limit(1),
    );
    return row?.title ?? null;
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

  /**
   * 顶层运行状态流转；succeeded/cancelled 终态不可被覆盖（failed 是页失败→重试的瞬态，允许回流转）。
   * 终态保护下沉到 UPDATE 条件（原子）：终态行 returning 为空，不产生任何写入。
   * 返回是否实际写入了状态（终态保护 no-op 时为 false）。
   */
  async updateStatus(id: string, status: string, extra: { errorSummary?: string | null } = {}): Promise<boolean> {
    const patch: Record<string, unknown> = { status, updatedAt: now() };
    if (status === "running") {
      const existing = await this.require(id);
      if (!existing.startedAt) patch.startedAt = now();
    }
    if (status === "queued") {
      patch.startedAt = null;
      patch.finishedAt = null;
    }
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      patch.finishedAt = now();
    }
    if (extra.errorSummary !== undefined) patch.errorSummary = extra.errorSummary;
    const updated = await this.client
      .update(workflowRuns)
      .set(patch)
      .where(and(eq(workflowRuns.id, id), notInArray(workflowRuns.status, [...RUN_TERMINAL_STATUSES])))
      .returning({ id: workflowRuns.id });
    return updated.length > 0;
  }

  async setSnapshot(id: string, snapshotJson: string) {
    await this.client
      .update(workflowRuns)
      .set({ snapshotJson, updatedAt: now() })
      .where(eq(workflowRuns.id, id));
  }

  /**
   * 为一次运行追加图片额度预留。钱包预留由 BillingService 先完成，
   * 本字段记录该运行仍需结算/释放的数量，支持失败重试时只补足差额。
   */
  async reserveCredits(id: string, amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("credit reservation amount must be a positive integer");
    const rows = await this.client
      .update(workflowRuns)
      .set({
        creditsReserved: sql`${workflowRuns.creditsReserved} + ${amount}`,
        updatedAt: now(),
      })
      .where(eq(workflowRuns.id, id))
      .returning({
        userId: workflowRuns.userId,
        creditsReserved: workflowRuns.creditsReserved,
        creditsCharged: workflowRuns.creditsCharged,
      });
    if (rows.length === 0) throw new Error(`workflow run not found: ${id}`);
    return rows[0]!;
  }

  /** 原子结算一批已预留图片额度；不足时返回 null，不允许静默少扣。 */
  async captureReservedCredits(id: string, amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("credit capture amount must be a positive integer");
    const rows = await this.client
      .update(workflowRuns)
      .set({
        creditsReserved: sql`${workflowRuns.creditsReserved} - ${amount}`,
        creditsCharged: sql`${workflowRuns.creditsCharged} + ${amount}`,
        updatedAt: now(),
      })
      .where(and(eq(workflowRuns.id, id), gte(workflowRuns.creditsReserved, amount)))
      .returning({
        userId: workflowRuns.userId,
        creditsReserved: workflowRuns.creditsReserved,
        creditsCharged: workflowRuns.creditsCharged,
      });
    return rows[0] ?? null;
  }

  /** 钱包结算失败时恢复运行侧的预留状态。 */
  async restoreCapturedCredits(id: string, amount: number): Promise<void> {
    if (!Number.isInteger(amount) || amount <= 0) return;
    await this.client
      .update(workflowRuns)
      .set({
        creditsReserved: sql`${workflowRuns.creditsReserved} + ${amount}`,
        creditsCharged: sql`${workflowRuns.creditsCharged} - ${amount}`,
        updatedAt: now(),
      })
      .where(and(eq(workflowRuns.id, id), gte(workflowRuns.creditsCharged, amount)));
  }

  /** 释放运行当前尚未结算的额度；amount 由调用方按最新运行状态传入。 */
  async releaseCredits(id: string, amount: number): Promise<void> {
    if (!Number.isInteger(amount) || amount <= 0) return;
    await this.client
      .update(workflowRuns)
      .set({ creditsReserved: sql`${workflowRuns.creditsReserved} - ${amount}`, updatedAt: now() })
      .where(and(eq(workflowRuns.id, id), gte(workflowRuns.creditsReserved, amount)));
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
      /** 本节点成功产出的模型额度；缺省按图片数兼容历史调用方 */
      credits?: number;
    } = {},
  ) {
    const images = extra.images ?? 0;
    const updated = await this.client
      .update(nodeRuns)
      .set({
        status: "succeeded",
        finishedAt: now(),
        outputRef: extra.outputRef ?? null,
        promptTokens: extra.promptTokens ?? 0,
        completionTokens: extra.completionTokens ?? 0,
        images,
        costUsd: extra.costUsd ?? null,
        ...(extra.model ? { model: extra.model } : {}),
      })
      // 同一节点重复恢复/回调时不重复触发计费钩子。
      .where(and(eq(nodeRuns.id, id), ne(nodeRuns.status, "succeeded")))
      .returning({ runId: nodeRuns.runId });
    if (updated.length === 0) return;
    if (images > 0 && this.nodeSucceededHooks.length > 0) {
      try {
        for (const hook of this.nodeSucceededHooks) {
          await hook({
            runId: updated[0]!.runId,
            nodeRunId: id,
            images,
            credits: extra.credits ?? images,
          });
        }
      } catch (error) {
        // 节点已经有可复用产物，但关键结算钩子失败时不能保留 succeeded；
        // 下次 Job 重试会复用 outputRef，再次尝试结算而不是把图片当成免费结果。
        await this.client
          .update(nodeRuns)
          .set({
            status: "failed",
            finishedAt: now(),
            errorCategory: "internal",
            errorSummary: `node completion hook failed: ${String(error).slice(0, 360)}`,
          })
          .where(eq(nodeRuns.id, id));
        throw error;
      }
    }
  }

  /** 覆写节点输出（例如返修后同步 Storyboard 文案） */
  async setNodeOutput(id: string, outputRef: string) {
    await this.client.update(nodeRuns).set({ outputRef }).where(eq(nodeRuns.id, id));
  }

  /**
   * 设置作品封面（可传 null 取消选择）。
   * 封面是增强能力，不做终态保护；更新后返回最新行。
   */
  async setSelectedCover(id: string, assetId: string | null) {
    await this.client
      .update(workflowRuns)
      .set({ selectedCoverAssetId: assetId, updatedAt: now() })
      .where(eq(workflowRuns.id, id));
    return this.require(id);
  }

  async failNode(
    id: string,
    category: ProviderErrorCategory | "internal",
    summary: string,
    extra: { outputRef?: string | null } = {},
  ) {
    await this.client
      .update(nodeRuns)
      .set({
        status: "failed",
        finishedAt: now(),
        errorCategory: category,
        errorSummary: summary,
        ...(extra.outputRef !== undefined ? { outputRef: extra.outputRef } : {}),
      })
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
      // returning 保证乐观抢占：已被其他持有者改走时返回空。
      // running 候选（租约过期遗留）必须同时原子比较租约旧值：若另一 worker 已续租/抢占，
      // 状态仍为 running（running→running 状态未变），仅靠 status 条件两个 worker 都会命中；
      // 追加租约比较后，被抢先的行 returning 为空，避免同一任务双执行。
      .where(
        and(
          eq(jobs.id, candidate.id),
          sql`${jobs.status} = ${candidate.status}`,
          recovered ? sql`(${jobs.leaseExpiresAt} IS NULL OR ${jobs.leaseExpiresAt} < ${ts})` : undefined,
        ),
      )
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

  /** 状态迁移只允许合法转换，终态不可再变更（原子：终态判断下沉到 UPDATE 条件，防止竞态覆盖） */
  async updateStatus(id: string, status: JobStatus, extra: { lastError?: string } = {}) {
    const updated = await this.client
      .update(jobs)
      .set({
        status,
        ...(extra.lastError !== undefined ? { lastError: extra.lastError } : {}),
        updatedAt: now(),
      })
      .where(and(eq(jobs.id, id), notInArray(jobs.status, [...JOB_TERMINAL_STATUSES])))
      .returning();
    if (updated.length > 0) return updated[0]!;
    // 终态：未写入，返回当前（不变）行
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
    // 仅更新仍处于停滞的行：SELECT 后任务可能已被心跳续租/抢占，避免误标活任务
    const recycled: Array<(typeof stalled)[number]> = [];
    for (const job of stalled) {
      const updated = await this.client
        .update(jobs)
        .set({
          status: job.attempts < job.maxAttempts ? "retry_waiting" : "failed",
          lastError: "stalled: no progress within timeout",
          updatedAt: ts,
        })
        .where(
          and(
            eq(jobs.id, job.id),
            sql`${jobs.status} = 'running' AND ${jobs.lastProgressAt} IS NOT NULL AND ${jobs.lastProgressAt} < ${ts - stallMs}`,
          ),
        )
        .returning({ id: jobs.id });
      if (updated.length === 0) continue;
      await this.appendEvent(job.id, "stalled", "no progress within timeout");
      recycled.push(job);
    }
    return recycled;
  }

  async list(limit = 100) {
    return this.client.select().from(jobs).orderBy(sql`${jobs.createdAt} DESC`).limit(limit);
  }

  async listByStatus(statuses: JobStatus[]) {
    return this.client.select().from(jobs).where(inArray(jobs.status, [...statuses]));
  }

  /** 启动回收：把全部 running（进程崩溃遗留）原子释放回 queued，并逐个写 orphan_recovered 事件 */
  async releaseStaleRunning(): Promise<number> {
    const ts = now();
    const released = await this.client
      .update(jobs)
      .set({ status: "queued", updatedAt: ts })
      .where(sql`${jobs.status} = 'running'`)
      .returning({ id: jobs.id });
    for (const row of released) {
      await this.appendEvent(row.id, "orphan_recovered", "released stale running lease on boot");
    }
    return released.length;
  }

  /** 某 Run 最近一次创建的作业（供详情/取消复用，替代 list(200).find）；无则返回 null */
  async findByRunId(runId: string): Promise<typeof jobs.$inferSelect | null> {
    const row = await one(
      this.client
        .select()
        .from(jobs)
        .where(eq(jobs.runId, runId))
        .orderBy(sql`${jobs.createdAt} DESC`)
        .limit(1),
    );
    return row ?? null;
  }

  /** 某 Run 最近一次指定 kind 的作业（如 cover_generate 的生成中状态判断）；无则返回 null */
  async findLatestByRunIdAndKind(runId: string, kind: string): Promise<typeof jobs.$inferSelect | null> {
    const row = await one(
      this.client
        .select()
        .from(jobs)
        .where(and(eq(jobs.runId, runId), eq(jobs.kind, kind)))
        .orderBy(sql`${jobs.createdAt} DESC`)
        .limit(1),
    );
    return row ?? null;
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
  concurrencyMax?: number;
  imageEditSupport?: number;
  priority?: number;
  userModelSelectionEnabled?: number;
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
  concurrencyMax?: number;
  imageEditSupport?: number;
  priority?: number;
  userModelSelectionEnabled?: number;
  modelsFetchedAt?: number | null;
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
        priority: input.priority ?? 0,
        userModelSelectionEnabled: input.userModelSelectionEnabled ?? 0,
        modelsFetchedAt: null,
        maxAttempts: input.maxAttempts ?? 3,
        concurrencyMax: input.concurrencyMax ?? 0,
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
    return this.client
      .select()
      .from(channels)
      .orderBy(sql`${channels.priority} DESC, ${channels.sortOrder} ASC`);
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

export interface ChannelModelCapabilities {
  textToImage?: boolean;
  imageEditSingle?: boolean;
  imageEditMulti?: boolean;
  maskEdit?: boolean;
}

export interface ChannelModelDiscoveryInput {
  providerModelId: string;
  displayName?: string;
  capabilities?: ChannelModelCapabilities;
}

export interface ChannelModelSettingsInput {
  providerModelId: string;
  enabled: number;
  isDefault: number;
  priority: number;
  creditsPerCall: number;
  capabilities: ChannelModelCapabilities;
}

function normalizeChannelModelCapabilities(value: ChannelModelCapabilities | undefined): ChannelModelCapabilities {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === "boolean"),
  ) as ChannelModelCapabilities;
}

/** 渠道模型目录仓储：发现与后台设置分离，重新获取模型不会覆盖管理员配置。 */
export class ChannelModelRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async listByChannel(channelId: string) {
    return this.client
      .select()
      .from(channelModels)
      .where(eq(channelModels.channelId, channelId))
      .orderBy(
        sql`${channelModels.priority} DESC, ${channelModels.createdAt} ASC, ${channelModels.id} ASC`,
      );
  }

  async listByChannels(channelIds: string[]) {
    if (channelIds.length === 0) return [];
    return this.client
      .select()
      .from(channelModels)
      .where(inArray(channelModels.channelId, channelIds))
      .orderBy(
        sql`${channelModels.priority} DESC, ${channelModels.createdAt} ASC, ${channelModels.id} ASC`,
      );
  }

  /** 将供应商模型写入目录。已存在模型只刷新名称和最近发现时间，不覆盖后台选择/价格/能力。 */
  async discover(channelId: string, type: string, inputs: ChannelModelDiscoveryInput[]) {
    const ts = now();
    for (const input of inputs) {
      await this.client
        .insert(channelModels)
        .values({
          id: newChannelModelId(),
          channelId,
          type,
          providerModelId: input.providerModelId,
          displayName: input.displayName?.trim() || input.providerModelId,
          enabled: 0,
          isDefault: 0,
          priority: 0,
          creditsPerCall: 1,
          capabilitiesJson: JSON.stringify(normalizeChannelModelCapabilities(input.capabilities)),
          discoveredAt: ts,
          lastSeenAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .onConflictDoUpdate({
          target: [channelModels.channelId, channelModels.providerModelId],
          set: {
            displayName: input.displayName?.trim() || input.providerModelId,
            lastSeenAt: ts,
            updatedAt: ts,
          },
        });
    }
    return this.listByChannel(channelId);
  }

  /** 新建/兼容旧字段时确保至少有一个可运行的默认模型。 */
  async ensureLegacyDefault(
    channelId: string,
    type: string,
    providerModelId: string | null | undefined,
    capabilities?: ChannelModelCapabilities,
  ) {
    if (!providerModelId?.trim()) return this.listByChannel(channelId);
    const modelId = providerModelId.trim();
    const ts = now();
    await this.client
      .update(channelModels)
      .set({ isDefault: 0, updatedAt: ts })
      .where(and(eq(channelModels.channelId, channelId), eq(channelModels.type, type)));
    await this.client
      .insert(channelModels)
      .values({
        id: newChannelModelId(),
        channelId,
        type,
        providerModelId: modelId,
        displayName: modelId,
        enabled: 1,
        isDefault: 1,
        priority: 0,
        creditsPerCall: 1,
        capabilitiesJson: JSON.stringify(normalizeChannelModelCapabilities(capabilities)),
        discoveredAt: ts,
        lastSeenAt: ts,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [channelModels.channelId, channelModels.providerModelId],
        set: {
          type,
          enabled: 1,
          isDefault: 1,
          lastSeenAt: ts,
          updatedAt: ts,
        },
      });
    return this.listByChannel(channelId);
  }

  /** 保存目录开关、默认模型、优先级、单次价格及能力；默认模型最多一个。 */
  async saveSettings(channelId: string, type: string, inputs: ChannelModelSettingsInput[]) {
    const existing = await this.listByChannel(channelId);
    const byProviderId = new Map(existing.filter((row) => row.type === type).map((row) => [row.providerModelId, row]));
    for (const input of inputs) {
      if (!byProviderId.has(input.providerModelId)) {
        throw new Error(`channel model not found: ${input.providerModelId}`);
      }
    }
    const enabled = inputs.filter((input) => input.enabled === 1);
    const requestedDefault = enabled.find((input) => input.isDefault === 1)?.providerModelId;
    const defaultProviderId = requestedDefault ?? enabled[0]?.providerModelId ?? null;
    const ts = now();
    await this.client.transaction(async (tx) => {
      await tx
        .update(channelModels)
        .set({ isDefault: 0, updatedAt: ts })
        .where(and(eq(channelModels.channelId, channelId), eq(channelModels.type, type)));
      for (const input of inputs) {
        await tx
          .update(channelModels)
          .set({
            enabled: input.enabled === 1 ? 1 : 0,
            isDefault: input.providerModelId === defaultProviderId ? 1 : 0,
            priority: input.priority,
            creditsPerCall: input.creditsPerCall,
            capabilitiesJson: JSON.stringify(normalizeChannelModelCapabilities(input.capabilities)),
            updatedAt: ts,
          })
          .where(
            and(
              eq(channelModels.channelId, channelId),
              eq(channelModels.type, type),
              eq(channelModels.providerModelId, input.providerModelId),
            ),
          );
      }
    });
    return this.listByChannel(channelId);
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
  /** 品牌名（可与手册名不同） */
  brandName?: string | null;
  slogan?: string | null;
  footerSignature?: string | null;
  watermarkText?: string | null;
  watermarkPosition?: string;
  watermarkOpacity?: number;
  titleFont?: string;
  /** 色板覆盖（对象形式；落库序列化为 JSON 文本） */
  paletteJson?: PaletteOverrides | null;
  coverLayout?: string;
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
        brandName: input.brandName ?? null,
        slogan: input.slogan ?? null,
        footerSignature: input.footerSignature ?? null,
        watermarkText: input.watermarkText ?? null,
        watermarkPosition: input.watermarkPosition ?? "corner",
        watermarkOpacity: input.watermarkOpacity ?? 0.18,
        titleFont: input.titleFont ?? "default",
        paletteJson: input.paletteJson ? JSON.stringify(input.paletteJson) : null,
        coverLayout: input.coverLayout ?? "default",
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
    // 可空字段：undefined（未提交）保持不变，null（显式清空）置 NULL
    if (patch.logoAssetId !== undefined) set.logoAssetId = patch.logoAssetId ?? null;
    if (patch.brandName !== undefined) set.brandName = patch.brandName ?? null;
    if (patch.slogan !== undefined) set.slogan = patch.slogan ?? null;
    if (patch.footerSignature !== undefined) set.footerSignature = patch.footerSignature ?? null;
    if (patch.watermarkText !== undefined) set.watermarkText = patch.watermarkText ?? null;
    if (patch.watermarkPosition !== undefined) set.watermarkPosition = patch.watermarkPosition;
    if (patch.watermarkOpacity !== undefined) set.watermarkOpacity = patch.watermarkOpacity;
    if (patch.titleFont !== undefined) set.titleFont = patch.titleFont;
    // paletteJson：null → 整块清空（置 NULL）；对象 → 序列化落库（键值可为 null，表示清除该色）
    if (patch.paletteJson !== undefined) {
      set.paletteJson = patch.paletteJson !== null ? JSON.stringify(patch.paletteJson) : null;
    }
    if (patch.coverLayout !== undefined) set.coverLayout = patch.coverLayout;
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

  async updateRole(id: string, role: "admin" | "user") {
    await this.client.update(users).set({ role, updatedAt: now() }).where(eq(users.id, id));
    return this.require(id);
  }

  /** 管理端用户列表（用户名搜索） */
  async listAdmin(q?: string, limit = 100) {
    return this.client
      .select()
      .from(users)
      .where(q ? like(users.username, `%${q}%`) : sql`true`)
      .orderBy(desc(users.createdAt))
      .limit(Math.min(limit, 200));
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

/* ── 计费：套餐 / 订单 / 钱包 / 订阅 / 流水 / 支付渠道配置 ────── */

export interface CreatePlanInput {
  code: string;
  name: string;
  description?: string;
  priceCents: number;
  periodDays?: number;
  creditsPerPeriod: number;
  features?: string[];
  active?: boolean;
  sortOrder?: number;
}

export class PlanRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async list(activeOnly = false) {
    const rows = await this.client
      .select()
      .from(plans)
      .where(activeOnly ? eq(plans.active, 1) : sql`true`)
      .orderBy(plans.sortOrder, plans.createdAt);
    return rows;
  }

  async require(id: string) {
    const row = await one(this.client.select().from(plans).where(eq(plans.id, id)).limit(1));
    if (!row) throw new Error(`plan not found: ${id}`);
    return row;
  }

  async findByCode(code: string) {
    return one(this.client.select().from(plans).where(eq(plans.code, code)).limit(1));
  }

  async create(input: CreatePlanInput) {
    const id = newPlanId();
    const ts = now();
    await this.client.insert(plans).values({
      id,
      code: input.code,
      name: input.name,
      description: input.description ?? "",
      priceCents: input.priceCents,
      periodDays: input.periodDays ?? 30,
      creditsPerPeriod: input.creditsPerPeriod,
      featuresJson: JSON.stringify(input.features ?? []),
      active: input.active === false ? 0 : 1,
      sortOrder: input.sortOrder ?? 0,
      createdAt: ts,
      updatedAt: ts,
    });
    return this.require(id);
  }

  async update(id: string, patch: Partial<CreatePlanInput>) {
    const row = await this.require(id);
    await this.client
      .update(plans)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.priceCents !== undefined ? { priceCents: patch.priceCents } : {}),
        ...(patch.periodDays !== undefined ? { periodDays: patch.periodDays } : {}),
        ...(patch.creditsPerPeriod !== undefined ? { creditsPerPeriod: patch.creditsPerPeriod } : {}),
        ...(patch.features !== undefined ? { featuresJson: JSON.stringify(patch.features) } : {}),
        ...(patch.active !== undefined ? { active: patch.active ? 1 : 0 } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        updatedAt: now(),
      })
      .where(eq(plans.id, id));
    void row;
    return this.require(id);
  }

  /** 删除（有订单引用时由调用方捕获外键错误转为 409） */
  async delete(id: string): Promise<void> {
    await this.client.delete(plans).where(eq(plans.id, id));
  }

  /** 内置套餐兜底 seed：仅在表为空时插入 */
  async ensureDefaults(): Promise<number> {
    const rows = await this.client.select({ n: sql<string>`count(*)` }).from(plans).limit(1);
    if (Number(rows[0]?.n ?? 0) > 0) return 0;
    const defaults: CreatePlanInput[] = [
      {
        code: "basic",
        name: "基础会员",
        description: "适合轻度创作的入门套餐",
        priceCents: 1990,
        creditsPerPeriod: 260,
        features: ["每月 260 点（约 260 张图）", "全部内容类型", "品牌手册"],
        sortOrder: 1,
      },
      {
        code: "pro",
        name: "专业会员",
        description: "高频创作者首选，点数单价更优",
        priceCents: 4990,
        creditsPerPeriod: 700,
        features: ["每月 700 点（约 700 张图）", "全部内容类型", "品牌手册", "封面候选", "优先渲染队列"],
        sortOrder: 2,
      },
    ];
    for (const item of defaults) await this.create(item);
    return defaults.length;
  }
}

export interface CreatePackageInput {
  name: string;
  credits: number;
  bonusCredits?: number;
  priceCents: number;
  active?: boolean;
  sortOrder?: number;
}

export class CreditPackageRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async list(activeOnly = false) {
    return this.client
      .select()
      .from(creditPackages)
      .where(activeOnly ? eq(creditPackages.active, 1) : sql`true`)
      .orderBy(creditPackages.sortOrder, creditPackages.createdAt);
  }

  async require(id: string) {
    const row = await one(this.client.select().from(creditPackages).where(eq(creditPackages.id, id)).limit(1));
    if (!row) throw new Error(`credit package not found: ${id}`);
    return row;
  }

  async create(input: CreatePackageInput) {
    const id = newPackageId();
    const ts = now();
    await this.client.insert(creditPackages).values({
      id,
      name: input.name,
      credits: input.credits,
      bonusCredits: input.bonusCredits ?? 0,
      priceCents: input.priceCents,
      active: input.active === false ? 0 : 1,
      sortOrder: input.sortOrder ?? 0,
      createdAt: ts,
      updatedAt: ts,
    });
    return this.require(id);
  }

  async update(id: string, patch: Partial<CreatePackageInput>) {
    await this.require(id);
    await this.client
      .update(creditPackages)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.credits !== undefined ? { credits: patch.credits } : {}),
        ...(patch.bonusCredits !== undefined ? { bonusCredits: patch.bonusCredits } : {}),
        ...(patch.priceCents !== undefined ? { priceCents: patch.priceCents } : {}),
        ...(patch.active !== undefined ? { active: patch.active ? 1 : 0 } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        updatedAt: now(),
      })
      .where(eq(creditPackages.id, id));
    return this.require(id);
  }

  async delete(id: string): Promise<void> {
    await this.client.delete(creditPackages).where(eq(creditPackages.id, id));
  }

  async ensureDefaults(): Promise<number> {
    const rows = await this.client.select({ n: sql<string>`count(*)` }).from(creditPackages).limit(1);
    if (Number(rows[0]?.n ?? 0) > 0) return 0;
    const defaults: CreatePackageInput[] = [
      { name: "体验包", credits: 100, bonusCredits: 0, priceCents: 1000, sortOrder: 1 },
      { name: "标准包", credits: 500, bonusCredits: 50, priceCents: 5000, sortOrder: 2 },
      { name: "专业包", credits: 1000, bonusCredits: 150, priceCents: 10000, sortOrder: 3 },
    ];
    for (const item of defaults) await this.create(item);
    return defaults.length;
  }
}

export type CreateOrderInput = {
  userId: string;
  type: "subscription" | "credits";
  planId?: string | null;
  packageId?: string | null;
  title: string;
  amountCents: number;
  credits: number;
  channel: "alipay" | "wechat" | "mock";
  operatorUserId?: string | null;
  /** 二维码内容（渠道返回的 code_url / qr_code）；mock 为空 */
  qrCode?: string | null;
  expiresAt?: number | null;
};

export interface AdminOrderFilter {
  status?: string;
  channel?: string;
  userId?: string;
  q?: string;
  limit?: number;
  offset?: number;
  page?: number;
  pageSize?: number;
}

export class OrderRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async create(input: CreateOrderInput) {
    const id = newOrderId();
    const ts = now();
    await this.client.insert(orders).values({
      id,
      orderNo: id.replace("ord_", "NO"),
      userId: input.userId,
      operatorUserId: input.operatorUserId ?? null,
      type: input.type,
      planId: input.planId ?? null,
      packageId: input.packageId ?? null,
      title: input.title,
      amountCents: input.amountCents,
      credits: input.credits,
      channel: input.channel,
      status: "pending",
      qrCode: input.qrCode ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: ts,
      updatedAt: ts,
    });
    return this.require(id);
  }

  async require(id: string) {
    const row = await one(this.client.select().from(orders).where(eq(orders.id, id)).limit(1));
    if (!row) throw new Error(`order not found: ${id}`);
    return row;
  }

  async findByOrderNo(orderNo: string) {
    return one(this.client.select().from(orders).where(eq(orders.orderNo, orderNo)).limit(1));
  }

  /**
   * 幂等支付完成：仅 pending → paid 允许转换，返回 null 表示已被处理过。
   * 终态（paid/failed/refunded/expired）不可覆盖，天然挡住渠道重复通知。
   */
  async markPaid(id: string, channelTradeNo: string | null) {
    const ts = now();
    const rows = await this.client
      .update(orders)
      .set({
        status: "paid",
        channelTradeNo,
        paidAt: ts,
        updatedAt: ts,
      })
      .where(and(eq(orders.id, id), eq(orders.status, "pending")))
      .returning({ id: orders.id });
    if (rows.length === 0) return null;
    return this.require(id);
  }

  async updateStatus(id: string, status: "failed" | "refunded" | "expired" | "pending", failReason?: string) {
    await this.client
      .update(orders)
      .set({ status, updatedAt: now(), ...(failReason !== undefined ? { failReason } : {}) })
      .where(eq(orders.id, id));
    return this.require(id);
  }

  async listByUser(userId: string, limit = 20) {
    return this.client
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit);
  }

  async listByUserPage(userId: string, page = 1, pageSize = 20): Promise<PageResult<typeof orders.$inferSelect>> {
    const paging = normalizePage(page, pageSize);
    const where = eq(orders.userId, userId);
    const [items, countRows] = await Promise.all([
      this.client
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(paging.pageSize)
        .offset((paging.page - 1) * paging.pageSize),
      this.client.select({ n: sql<string>`count(*)` }).from(orders).where(where),
    ]);
    return toPageResult(items, Number(countRows[0]?.n ?? 0), paging.page, paging.pageSize);
  }

  private orderConditions(filter: AdminOrderFilter) {
    const conditions = [];
    if (filter.status) conditions.push(eq(orders.status, filter.status));
    if (filter.channel) conditions.push(eq(orders.channel, filter.channel));
    if (filter.userId) conditions.push(eq(orders.userId, filter.userId));
    if (filter.q) {
      conditions.push(
        sql`(${orders.title} ILIKE ${`%${filter.q}%`} OR ${orders.orderNo} ILIKE ${`%${filter.q}%`})`,
      );
    }
    return conditions;
  }

  async listAdmin(filter: AdminOrderFilter = {}) {
    const conditions = this.orderConditions(filter);
    return this.client
      .select()
      .from(orders)
      .where(conditions.length > 0 ? and(...conditions) : sql`true`)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(Math.min(filter.limit ?? 50, 200))
      .offset(filter.offset ?? 0);
  }

  async listAdminPage(filter: AdminOrderFilter = {}): Promise<PageResult<typeof orders.$inferSelect>> {
    const paging = normalizePage(filter.page, filter.pageSize);
    const conditions = this.orderConditions(filter);
    const where = conditions.length > 0 ? and(...conditions) : sql`true`;
    const [items, countRows] = await Promise.all([
      this.client
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(paging.pageSize)
        .offset((paging.page - 1) * paging.pageSize),
      this.client.select({ n: sql<string>`count(*)` }).from(orders).where(where),
    ]);
    return toPageResult(items, Number(countRows[0]?.n ?? 0), paging.page, paging.pageSize);
  }

  async countAll() {
    const rows = await this.client.select({ n: sql<string>`count(*)` }).from(orders).limit(1);
    return Number(rows[0]?.n ?? 0);
  }

  /** 已支付订单按日收入（后台收入统计） */
  async revenueByDay(sinceMs: number) {
    const rows = await this.client
      .select({
        day: sql<string>`to_char(timezone('Asia/Shanghai', to_timestamp(${orders.paidAt} / 1000)), 'YYYY-MM-DD')`,
        totalCents: sql<string>`coalesce(sum(${orders.amountCents}), 0)`,
        count: sql<string>`count(*)`,
      })
      .from(orders)
      .where(and(eq(orders.status, "paid"), ne(orders.type, "admin_adjust"), gte(orders.paidAt, sinceMs)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows.map((row) => ({ day: row.day, totalCents: Number(row.totalCents), count: Number(row.count) }));
  }

  /** 已支付收入按渠道汇总 */
  async revenueByChannel() {
    const rows = await this.client
      .select({
        channel: orders.channel,
        totalCents: sql<string>`coalesce(sum(${orders.amountCents}), 0)`,
        count: sql<string>`count(*)`,
      })
      .from(orders)
      .where(and(eq(orders.status, "paid"), ne(orders.type, "admin_adjust")))
      .groupBy(orders.channel);
    return rows.map((row) => ({ channel: row.channel, totalCents: Number(row.totalCents), count: Number(row.count) }));
  }

  /** 订单状态分布 */
  async statusCounts() {
    const rows = await this.client
      .select({ status: orders.status, count: sql<string>`count(*)` })
      .from(orders)
      .groupBy(orders.status);
    return rows.map((row) => ({ status: row.status, count: Number(row.count) }));
  }
}

export class WalletRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async findByUser(userId: string) {
    return one(this.client.select().from(wallets).where(eq(wallets.userId, userId)).limit(1));
  }

  /** 首次访问创建钱包（starterCredits 记为初始余额）；返回是否新建 */
  async ensure(userId: string, starterCredits: number): Promise<{ wallet: WalletRow; created: boolean }> {
    const ts = now();
    const inserted = await this.client
      .insert(wallets)
      .values({
        id: newWalletId(),
        userId,
        balance: Math.max(0, starterCredits),
        totalGranted: Math.max(0, starterCredits),
        updatedAt: ts,
      })
      .onConflictDoNothing({ target: wallets.userId })
      .returning();
    if (inserted.length > 0) return { wallet: inserted[0] as WalletRow, created: true };
    const wallet = await this.findByUser(userId);
    if (!wallet) throw new Error(`wallet not found for user ${userId}`);
    return { wallet, created: false };
  }

  /** 入账（正数）。返回最新余额。 */
  async credit(userId: string, delta: number): Promise<number> {
    if (!Number.isInteger(delta) || delta < 0) throw new Error("credit amount must be a non-negative integer");
    if (delta === 0) {
      const current = await this.findByUser(userId);
      if (!current) throw new Error(`wallet not found for user ${userId}`);
      return current.balance - current.reservedCredits;
    }
    const rows = await this.client
      .update(wallets)
      .set({
        balance: sql`${wallets.balance} + ${delta}`,
        totalGranted: sql`${wallets.totalGranted} + ${delta}`,
        updatedAt: now(),
      })
      .where(eq(wallets.userId, userId))
      .returning({ balance: wallets.balance, reservedCredits: wallets.reservedCredits });
    if (rows.length === 0) throw new Error(`wallet not found for user ${userId}`);
    return rows[0]!.balance - rows[0]!.reservedCredits;
  }

  /**
   * 非预留扣减（正数）。只允许一次性全额扣减，不再“扣到 0”静默少扣；
   * 同时不触碰其它运行已预留的额度。返回 { deducted, balanceAfter }。
   */
  async debit(userId: string, amount: number): Promise<{ deducted: number; balanceAfter: number }> {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("debit amount must be a positive integer");
    const full = await this.client
      .update(wallets)
      .set({
        balance: sql`${wallets.balance} - ${amount}`,
        totalConsumed: sql`${wallets.totalConsumed} + ${amount}`,
        updatedAt: now(),
      })
      .where(
        and(
          eq(wallets.userId, userId),
          sql`${wallets.balance} - ${wallets.reservedCredits} >= ${amount}`,
        ),
      )
      .returning({ balance: wallets.balance, reservedCredits: wallets.reservedCredits });
    if (full.length > 0) {
      return {
        deducted: amount,
        balanceAfter: full[0]!.balance - full[0]!.reservedCredits,
      };
    }
    const current = await this.findByUser(userId);
    return {
      deducted: 0,
      balanceAfter: current ? current.balance - current.reservedCredits : 0,
    };
  }

  /** 原子预留额度；返回 null 表示可用余额不足或钱包不存在。 */
  async reserveCredits(
    userId: string,
    amount: number,
  ): Promise<{ balance: number; reservedCredits: number; available: number } | null> {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("credit reservation amount must be a positive integer");
    const rows = await this.client
      .update(wallets)
      .set({
        reservedCredits: sql`${wallets.reservedCredits} + ${amount}`,
        updatedAt: now(),
      })
      .where(
        and(
          eq(wallets.userId, userId),
          sql`${wallets.balance} - ${wallets.reservedCredits} >= ${amount}`,
        ),
      )
      .returning({ balance: wallets.balance, reservedCredits: wallets.reservedCredits });
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return { ...row, available: row.balance - row.reservedCredits };
  }

  /** 原子结算已预留额度；不足时返回 null，禁止少扣或透支。 */
  async captureReservedCredits(
    userId: string,
    amount: number,
  ): Promise<{ balance: number; reservedCredits: number; available: number } | null> {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("credit capture amount must be a positive integer");
    const rows = await this.client
      .update(wallets)
      .set({
        balance: sql`${wallets.balance} - ${amount}`,
        reservedCredits: sql`${wallets.reservedCredits} - ${amount}`,
        totalConsumed: sql`${wallets.totalConsumed} + ${amount}`,
        updatedAt: now(),
      })
      .where(
        and(
          eq(wallets.userId, userId),
          gte(wallets.reservedCredits, amount),
          gte(wallets.balance, amount),
        ),
      )
      .returning({ balance: wallets.balance, reservedCredits: wallets.reservedCredits });
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return { ...row, available: row.balance - row.reservedCredits };
  }

  /** 释放尚未结算的预留额度。 */
  async releaseReservedCredits(userId: string, amount: number): Promise<number> {
    if (!Number.isInteger(amount) || amount <= 0) return 0;
    const rows = await this.client
      .update(wallets)
      .set({ reservedCredits: sql`${wallets.reservedCredits} - ${amount}`, updatedAt: now() })
      .where(and(eq(wallets.userId, userId), gte(wallets.reservedCredits, amount)))
      .returning({ balance: wallets.balance, reservedCredits: wallets.reservedCredits });
    if (rows.length === 0) return 0;
    return rows[0]!.balance - rows[0]!.reservedCredits;
  }

  /** 钱包结算失败时恢复一次已结算的额度（补偿操作）。 */
  async restoreCapturedCredits(userId: string, amount: number): Promise<void> {
    if (!Number.isInteger(amount) || amount <= 0) return;
    await this.client
      .update(wallets)
      .set({
        balance: sql`${wallets.balance} + ${amount}`,
        reservedCredits: sql`${wallets.reservedCredits} + ${amount}`,
        totalConsumed: sql`${wallets.totalConsumed} - ${amount}`,
        updatedAt: now(),
      })
      .where(eq(wallets.userId, userId));
  }

  /** 批量取钱包（管理端用户列表） */
  async forUsers(userIds: string[]): Promise<Map<string, WalletRow>> {
    const map = new Map<string, WalletRow>();
    if (userIds.length === 0) return map;
    const rows = await this.client.select().from(wallets).where(inArray(wallets.userId, userIds));
    for (const row of rows) map.set(row.userId, row);
    return map;
  }
}

type WalletRow = typeof wallets.$inferSelect;

export interface CreateSubscriptionInput {
  userId: string;
  planId: string;
  startedAt: number;
  expiresAt: number;
  lastGrantAt: number;
}

export class SubscriptionRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async activeFor(userId: string) {
    return one(
      this.client
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active")))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1),
    );
  }

  async require(id: string) {
    const row = await one(this.client.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1));
    if (!row) throw new Error(`subscription not found: ${id}`);
    return row;
  }

  async create(input: CreateSubscriptionInput) {
    const id = newSubscriptionId();
    const ts = now();
    await this.client.insert(subscriptions).values({
      id,
      userId: input.userId,
      planId: input.planId,
      status: "active",
      startedAt: input.startedAt,
      expiresAt: input.expiresAt,
      lastGrantAt: input.lastGrantAt,
      createdAt: ts,
      updatedAt: ts,
    });
    return this.require(id);
  }

  /** 续费顺延：expiresAt 与 lastGrantAt 直接替换（服务层负责叠加计算） */
  async extend(id: string, expiresAt: number, lastGrantAt: number) {
    await this.client
      .update(subscriptions)
      .set({ expiresAt, lastGrantAt, updatedAt: now() })
      .where(eq(subscriptions.id, id));
    return this.require(id);
  }

  /** 批量取生效订阅（管理端用户列表） */
  async listActiveForUsers(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.client
      .select()
      .from(subscriptions)
      .where(and(inArray(subscriptions.userId, userIds), eq(subscriptions.status, "active")));
  }

  async expireOverdue(nowMs: number): Promise<void> {
    await this.client
      .update(subscriptions)
      .set({ status: "expired", updatedAt: nowMs })
      .where(and(eq(subscriptions.status, "active"), sql`${subscriptions.expiresAt} < ${nowMs}`));
  }
}

export type LedgerEntryInput = {
  userId: string;
  delta: number;
  balanceAfter: number;
  reason: "starter" | "purchase" | "subscription_grant" | "consume" | "admin_adjust" | "refund";
  runId?: string | null;
  refType?: string | null;
  refId?: string | null;
  displayTitle?: string | null;
  note?: string | null;
};

export class InsufficientWalletCreditsError extends Error {
  constructor(public readonly balance: number, public readonly needed: number) {
    super(`insufficient available credits: balance=${balance} needed=${needed}`);
    this.name = "InsufficientWalletCreditsError";
  }
}

export class LedgerRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async append(entry: LedgerEntryInput) {
    const id = newLedgerId();
    await this.client.insert(creditLedger).values({
      id,
      userId: entry.userId,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      runId: entry.runId ?? null,
      refType: entry.refType ?? null,
      refId: entry.refId ?? null,
      displayTitle: entry.displayTitle ?? null,
      note: entry.note ?? null,
      createdAt: now(),
    });
    return id;
  }

  async listByUser(userId: string, limit = 20, offset = 0) {
    return this.client
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId))
      .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
      .limit(Math.min(limit, 100))
      .offset(offset);
  }

  async listByUserPage(userId: string, page = 1, pageSize = 20): Promise<PageResult<typeof creditLedger.$inferSelect>> {
    const paging = normalizePage(page, pageSize);
    const where = eq(creditLedger.userId, userId);
    const [items, countRows] = await Promise.all([
      this.client
        .select()
        .from(creditLedger)
        .where(where)
        .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
        .limit(paging.pageSize)
        .offset((paging.page - 1) * paging.pageSize),
      this.client.select({ n: sql<string>`count(*)` }).from(creditLedger).where(where),
    ]);
    return toPageResult(items, Number(countRows[0]?.n ?? 0), paging.page, paging.pageSize);
  }

  async listAdmin(limit = 50, offset = 0, userId?: string) {
    return this.client
      .select()
      .from(creditLedger)
      .where(userId ? eq(creditLedger.userId, userId) : sql`true`)
      .orderBy(desc(creditLedger.createdAt))
      .limit(Math.min(limit, 200))
      .offset(offset);
  }

  /**
   * 在一个数据库事务中完成管理员调点：钱包、调整订单、点数流水必须同时落库。
   * 首次触发时也把注册赠送流水放在同一事务内，避免出现孤立的钱包或半笔审计记录。
   */
  async applyAdminAdjustment(input: {
    userId: string;
    operatorUserId?: string | null;
    delta: number;
    note: string;
    starterCredits: number;
  }): Promise<{ balance: number; orderId: string; orderNo: string; delta: number }> {
    if (!Number.isInteger(input.delta) || input.delta === 0) {
      throw new Error("admin adjustment delta must be a non-zero integer");
    }
    const note = input.note.trim();
    if (!note) throw new Error("admin adjustment note is required");

    const orderId = newOrderId();
    const orderNo = orderId.replace("ord_", "ADJ");
    const ledgerId = newLedgerId();
    const starterCredits = Math.max(0, Math.trunc(input.starterCredits));
    const adjusted = input.delta;

    return this.client.transaction(async (tx) => {
      const ts = now();
      const insertedWallets = await tx
        .insert(wallets)
        .values({
          id: newWalletId(),
          userId: input.userId,
          balance: starterCredits,
          totalGranted: starterCredits,
          updatedAt: ts,
        })
        .onConflictDoNothing({ target: wallets.userId })
        .returning();

      if (insertedWallets.length > 0 && starterCredits > 0) {
        await tx.insert(creditLedger).values({
          id: newLedgerId(),
          userId: input.userId,
          delta: starterCredits,
          balanceAfter: starterCredits,
          reason: "starter",
          runId: null,
          refType: null,
          refId: null,
          displayTitle: "注册赠送点数",
          note: "注册赠送点数",
          createdAt: ts,
        });
      }

      const walletRows = adjusted > 0
        ? await tx
            .update(wallets)
            .set({
              balance: sql`${wallets.balance} + ${adjusted}`,
              totalGranted: sql`${wallets.totalGranted} + ${adjusted}`,
              updatedAt: ts,
            })
            .where(eq(wallets.userId, input.userId))
            .returning({ balance: wallets.balance, reservedCredits: wallets.reservedCredits })
        : await tx
            .update(wallets)
            .set({
              balance: sql`${wallets.balance} - ${-adjusted}`,
              totalConsumed: sql`${wallets.totalConsumed} + ${-adjusted}`,
              updatedAt: ts,
            })
            .where(
              and(
                eq(wallets.userId, input.userId),
                sql`${wallets.balance} - ${wallets.reservedCredits} >= ${-adjusted}`,
              ),
            )
            .returning({ balance: wallets.balance, reservedCredits: wallets.reservedCredits });

      if (walletRows.length === 0) {
        const current = await one(
          tx.select({ balance: wallets.balance, reservedCredits: wallets.reservedCredits })
            .from(wallets)
            .where(eq(wallets.userId, input.userId))
            .limit(1),
        );
        throw new InsufficientWalletCreditsError(
          current ? current.balance - current.reservedCredits : 0,
          -adjusted,
        );
      }

      const wallet = walletRows[0]!;
      const balance = wallet.balance - wallet.reservedCredits;
      await tx.insert(orders).values({
        id: orderId,
        orderNo,
        userId: input.userId,
        operatorUserId: input.operatorUserId ?? null,
        type: "admin_adjust",
        planId: null,
        packageId: null,
        title: note,
        amountCents: 0,
        credits: adjusted,
        channel: "admin",
        status: "adjusted",
        qrCode: null,
        channelTradeNo: null,
        failReason: null,
        paidAt: null,
        expiresAt: null,
        createdAt: ts,
        updatedAt: ts,
      });
      await tx.insert(creditLedger).values({
        id: ledgerId,
        userId: input.userId,
        delta: adjusted,
        balanceAfter: balance,
        reason: "admin_adjust",
        runId: null,
        refType: "order",
        refId: orderId,
        displayTitle: note,
        note,
        createdAt: ts,
      });
      return { balance, orderId, orderNo, delta: adjusted };
    });
  }

  /** 按原因汇总（对账用） */
  async sumByReason(sinceMs?: number) {
    const rows = await this.client
      .select({
        reason: creditLedger.reason,
        total: sql<string>`coalesce(sum(${creditLedger.delta}), 0)`,
      })
      .from(creditLedger)
      .where(sinceMs ? gte(creditLedger.createdAt, sinceMs) : sql`true`)
      .groupBy(creditLedger.reason);
    return rows.map((row) => ({ reason: row.reason, total: Number(row.total) }));
  }
}

export class PaymentConfigRepo {
  private readonly client: DbClient;
  constructor(db: Db) {
    this.client = db as DbClient;
  }

  async get(channel: string) {
    return one(this.client.select().from(paymentConfigs).where(eq(paymentConfigs.id, channel)).limit(1));
  }

  async list() {
    return this.client.select().from(paymentConfigs).orderBy(paymentConfigs.id);
  }

  async upsert(channel: string, patch: { enabled?: boolean; configJson?: string; secretsEncrypted?: string | null }) {
    const ts = now();
    await this.client
      .insert(paymentConfigs)
      .values({
        id: channel,
        enabled: patch.enabled === true ? 1 : 0,
        configJson: patch.configJson ?? "{}",
        secretsEncrypted: patch.secretsEncrypted ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: paymentConfigs.id,
        set: {
          ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
          ...(patch.configJson !== undefined ? { configJson: patch.configJson } : {}),
          ...(patch.secretsEncrypted !== undefined ? { secretsEncrypted: patch.secretsEncrypted } : {}),
          updatedAt: ts,
        },
      });
    return this.require(channel);
  }

  async require(channel: string) {
    const row = await this.get(channel);
    if (!row) throw new Error(`payment config not found: ${channel}`);
    return row;
  }
}
