import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { platformAccounts, publishJobs } from "../db/schema";
import type { PlatformDraftInput, PublishAuthorization } from "@aai/shared-schemas";
import { AiError, newId } from "@aai/ai-core";

// ---------------------------------------------------------------------------
// Platform adapter contract (phase 3). Adapters are isolated from core and can
// be disabled without touching generation/export.
// ---------------------------------------------------------------------------

export interface AuthStatus {
  ok: boolean;
  message: string;
}

export interface DraftResult {
  externalId: string;
  status: "created" | "already_exists";
}

export interface PlatformAdapter {
  readonly platform: string;
  readonly enabled: boolean;
  checkAuth(accountId: string): Promise<AuthStatus>;
  validateDraft(input: PlatformDraftInput): Promise<{ ok: boolean; problems: string[] }>;
  createDraft(input: PlatformDraftInput, idempotencyKey: string): Promise<DraftResult>;
  capabilities(): { supportsDraft: boolean; supportsPublish: boolean; maxImages: number; titleMax: number };
}

function idempotencyKey(input: PlatformDraftInput, operation: string): string {
  return createHash("sha256")
    .update(`${input.accountId}:${input.platform}:${input.projectVersion}:${operation}`)
    .digest("hex")
    .slice(0, 40);
}

/**
 * 微信公众号草稿 Adapter — 首选官方 API。凭据（appid + app secret）存在
 * platform_accounts.credential（JSON）。未配置凭据时返回明确错误而不是静默失败。
 */
class WeChatAdapter implements PlatformAdapter {
  readonly platform = "wechat";
  readonly enabled = process.env.DISABLE_PLATFORM_ADAPTERS !== "1";

  capabilities() {
    return { supportsDraft: true, supportsPublish: false, maxImages: 20, titleMax: 64 };
  }

  async checkAuth(accountId: string): Promise<AuthStatus> {
    const cred = this.credential(accountId);
    if (!cred) return { ok: false, message: "未配置 appid/secret" };
    try {
      const res = await fetch(
        `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${cred.appid}&secret=${cred.secret}`
      );
      const json = (await res.json()) as { access_token?: string; errcode?: number; errmsg?: string };
      return json.access_token
        ? { ok: true, message: "凭据有效" }
        : { ok: false, message: `微信返回错误 ${json.errcode}: ${json.errmsg}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "网络错误" };
    }
  }

  async validateDraft(input: PlatformDraftInput): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = [];
    if (input.title.length > 64) problems.push("标题超过 64 字");
    if (input.imageAssetIds.length === 0) problems.push("缺少封面图片");
    return { ok: problems.length === 0, problems };
  }

  async createDraft(input: PlatformDraftInput, _idempotencyKey: string): Promise<DraftResult> {
    const cred = this.credential(input.accountId);
    if (!cred) throw new AiError("invalid_input", "微信公众号凭据未配置（appid/secret），请在平台账号中填写");
    // 1) upload thumb media 2) create draft — 完整实现需要素材库；此处调用草稿接口
    const tokenRes = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${cred.appid}&secret=${cred.secret}`
    );
    const token = (await tokenRes.json()) as { access_token?: string; errmsg?: string };
    if (!token.access_token) throw new AiError("auth", `获取 access_token 失败: ${token.errmsg ?? "unknown"}`);

    const articles = {
      articles: [
        {
          title: input.title,
          author: "AI Auto Image",
          digest: input.body.slice(0, 120),
          content: input.body.replace(/\n/g, "<br/>"),
          need_open_comment: 0,
          only_fans_can_comment: 0,
        },
      ],
    };
    const res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token.access_token}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(articles) }
    );
    const json = (await res.json()) as { media_id?: string; errcode?: number; errmsg?: string };
    if (!json.media_id) throw new AiError("upstream", `创建草稿失败: ${json.errcode} ${json.errmsg}`);
    return { externalId: json.media_id, status: "created" };
  }

  private credential(accountId: string): { appid: string; secret: string } | null {
    const db = getDb();
    const account = db.select().from(platformAccounts).where(eq(platformAccounts.id, accountId)).get();
    if (!account?.credential) return null;
    try {
      return JSON.parse(account.credential) as { appid: string; secret: string };
    } catch {
      return null;
    }
  }
}

/**
 * 小红书 Adapter — 通过外部 xiaohongshu-mcp 服务（XHS_MCP_URL）隔离登录态与
 * 浏览器自动化；核心服务不保存 Cookie。未配置时接口返回明确错误。
 */
class XiaohongshuAdapter implements PlatformAdapter {
  readonly platform = "xiaohongshu";
  readonly enabled = process.env.DISABLE_PLATFORM_ADAPTERS !== "1";

  capabilities() {
    return { supportsDraft: true, supportsPublish: true, maxImages: 18, titleMax: 20 };
  }

  private mcpUrl(): string | null {
    return process.env.XHS_MCP_URL ?? null;
  }

  async checkAuth(_accountId: string): Promise<AuthStatus> {
    const url = this.mcpUrl();
    if (!url) return { ok: false, message: "未配置 XHS_MCP_URL（xiaohongshu-mcp 服务地址）" };
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/status`, { method: "GET" });
      const text = await res.text();
      return res.ok ? { ok: true, message: text.slice(0, 120) } : { ok: false, message: `状态异常 HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "网络错误" };
    }
  }

  async validateDraft(input: PlatformDraftInput): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = [];
    if (input.title.length > 20) problems.push("小红书标题不能超过 20 字");
    if (input.imageAssetIds.length > 18) problems.push("图片最多 18 张");
    if (input.imageAssetIds.length === 0) problems.push("至少需要 1 张图片");
    return { ok: problems.length === 0, problems };
  }

  async createDraft(input: PlatformDraftInput, _idempotencyKey: string): Promise<DraftResult> {
    const url = this.mcpUrl();
    if (!url) throw new AiError("invalid_input", "未配置 XHS_MCP_URL，无法写入小红书草稿");
    const res = await fetch(`${url.replace(/\/$/, "")}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        tags: input.tags,
        imageAssetIds: input.imageAssetIds,
        visibility: input.visibility,
        idempotencyKey: _idempotencyKey,
      }),
    });
    if (!res.ok) throw new AiError("upstream", `小红书草稿写入失败 HTTP ${res.status}`);
    const json = (await res.json()) as { externalId?: string; noteId?: string };
    return { externalId: json.noteId ?? json.externalId ?? randomUUID(), status: "created" };
  }
}

const ADAPTERS: Record<string, PlatformAdapter> = {
  wechat: new WeChatAdapter(),
  xiaohongshu: new XiaohongshuAdapter(),
};

export function getAdapter(platform: string): PlatformAdapter | null {
  return ADAPTERS[platform] ?? null;
}

// ---------------------------------------------------------------------------
// Publish pipeline with idempotency + explicit authorization
// ---------------------------------------------------------------------------

export interface CreateDraftRequest {
  projectId: string;
  platform: string;
  accountId: string;
  scope: "draft" | "publish";
  input: PlatformDraftInput;
  authorization: PublishAuthorization;
}

/**
 * Duplicate submissions with the same idempotency key return the existing job
 * instead of writing to the platform twice. Write-result-unknown situations
 * must be reconciled by querying external status — never blind-retried.
 */
export async function createPlatformDraft(req: CreateDraftRequest): Promise<{ jobId: string; duplicate: boolean }> {
  const db = getDb();
  const key = idempotencyKey(req.input, req.scope);

  const existing = db.select().from(publishJobs).where(eq(publishJobs.idempotencyKey, key)).get();
  if (existing) {
    return { jobId: existing.id, duplicate: true };
  }

  const adapter = getAdapter(req.platform);
  if (!adapter) throw new AiError("unsupported", `平台 ${req.platform} 暂不支持`);
  if (!adapter.enabled) throw new AiError("unsupported", "平台适配器已被禁用");
  if (req.scope === "publish" && !adapter.capabilities().supportsPublish) {
    throw new AiError("unsupported", `${req.platform} 不支持正式发布，仅支持草稿`);
  }

  const jobId = newId("pj");
  db.insert(publishJobs)
    .values({
      id: jobId,
      projectId: req.projectId,
      platform: req.platform,
      accountId: req.accountId,
      scope: req.scope,
      idempotencyKey: key,
      status: "pending",
      authorization: JSON.stringify(req.authorization),
      input: JSON.stringify(req.input),
    })
    .run();

  // validate + execute inline (bounded, single attempt; no blind retries)
  const validation = await adapter.validateDraft(req.input);
  if (!validation.ok) {
    db.update(publishJobs)
      .set({ status: "failed", error: validation.problems.join("；"), updatedAt: new Date().toISOString() })
      .where(eq(publishJobs.id, jobId))
      .run();
    throw new AiError("invalid_input", `草稿校验失败：${validation.problems.join("；")}`);
  }

  try {
    const result = await adapter.createDraft(req.input, key);
    db.update(publishJobs)
      .set({
        status: "draft_created",
        externalId: result.externalId,
        result: JSON.stringify(result),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(publishJobs.id, jobId))
      .run();
  } catch (err) {
    db.update(publishJobs)
      .set({
        status: "unknown_result",
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(publishJobs.id, jobId))
      .run();
    throw err;
  }
  return { jobId, duplicate: false };
}

export function listPlatformAccounts() {
  return getDb().select().from(platformAccounts).all();
}

export function findPublishJobByProject(projectId: string) {
  return getDb().select().from(publishJobs).where(and(eq(publishJobs.projectId, projectId))).all();
}
