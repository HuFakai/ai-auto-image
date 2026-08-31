import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireAdmin } from "@/server/auth";
import { decryptApiKey, encryptApiKey, getEncryptionKey } from "@/server/channel-crypto";

export const dynamic = "force-dynamic";

const dataDir = () => process.env.DATA_DIR ?? "data";

/** 支付渠道参数（alipay|wechat）：读脱敏、写加密 */
const SECRET_FIELDS: Record<string, string[]> = {
  alipay: ["appPrivateKey", "alipayPublicKey"],
  wechat: ["privateKey", "apiv3Key", "verifyKeyPem"],
};

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  const [alipay, wechat] = await Promise.all([
    runtime.paymentConfigRepo.get("alipay"),
    runtime.paymentConfigRepo.get("wechat"),
  ]);
  return NextResponse.json({
    alipay: {
      enabled: alipay?.enabled === 1,
      config: JSON.parse(alipay?.configJson || "{}") as Record<string, string>,
      hasSecrets: Boolean(alipay?.secretsEncrypted),
    },
    wechat: {
      enabled: wechat?.enabled === 1,
      config: JSON.parse(wechat?.configJson || "{}") as Record<string, string>,
      hasSecrets: Boolean(wechat?.secretsEncrypted),
    },
    envHint: {
      notifyBaseUrl: process.env.PAY_NOTIFY_BASE_URL ?? "",
    },
  });
}

/** 保存：config 明文 JSON；secret 字段有值则加密合并（留空保持不变），显式传 null 清除 */
export async function PUT(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as {
    channel?: string;
    enabled?: boolean;
    config?: Record<string, string>;
    secrets?: Record<string, string | null>;
  };
  if (body.channel !== "alipay" && body.channel !== "wechat") {
    return NextResponse.json({ error: "channel 必须为 alipay|wechat" }, { status: 400 });
  }
  const runtime = await getRuntime();
  const existing = await runtime.paymentConfigRepo.get(body.channel);
  const currentConfig = JSON.parse(existing?.configJson || "{}") as Record<string, string>;
  const mergedConfig = { ...currentConfig, ...(body.config ?? {}) };

  // secrets：从现有解密出发，合并本次提交
  let secretsEncrypted = existing?.secretsEncrypted ?? null;
  let currentSecrets: Record<string, string> = {};
  if (secretsEncrypted) {
    try {
      currentSecrets = JSON.parse(decryptApiKey(getEncryptionKey(dataDir()), secretsEncrypted)) as Record<string, string>;
    } catch {
      currentSecrets = {};
    }
  }
  const secretFields = SECRET_FIELDS[body.channel] ?? [];
  for (const field of secretFields) {
    const submitted = body.secrets ? body.secrets[field] : undefined;
    if (submitted !== undefined) {
      if (submitted === null || submitted === "") delete currentSecrets[field];
      else currentSecrets[field] = submitted;
    }
  }
  secretsEncrypted = Object.keys(currentSecrets).length > 0 ? encryptApiKey(getEncryptionKey(dataDir()), JSON.stringify(currentSecrets)) : null;

  await runtime.paymentConfigRepo.upsert(body.channel, {
    enabled: body.enabled,
    configJson: JSON.stringify(mergedConfig),
    secretsEncrypted,
  });
  return NextResponse.json({ ok: true });
}
