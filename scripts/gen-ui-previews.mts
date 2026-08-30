/** 开发脚本:解密 gpt 渠道密钥并调用 gpt-image-2 生成 UI 预览效果图(密钥不打印) */
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import postgres from "postgres";

const root = path.resolve(import.meta.dirname, "..");
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

function encryptionKey(): Buffer {
  const secret = process.env.APP_SECRET;
  const value =
    secret && secret.length > 0
      ? secret
      : fs.readFileSync(path.join(root, "apps/web/data/.secret"), "utf8").trim();
  return scryptSync(value, "aai-channel-key", 32);
}

function decrypt(key: Buffer, stored: string): string {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const rows = await sql`select id, name, type, base_url, api_key_encrypted, image_model from channels where type = 'image'`;
await sql.end({ timeout: 3 });
const key = encryptionKey();
const manualKey = process.env.GPT_IMAGE_KEY;
const gpt = rows
  .map((r) => ({ ...r, apiKey: manualKey ?? decrypt(key(), r.api_key_encrypted) }))
  .find((r) => (r.image_model ?? "").toLowerCase().includes("gpt-image"));
if (!gpt) {
  console.error("未找到 gpt-image 渠道;现有:", rows.map((r) => `${r.name}:${r.image_model}`).join(", "));
  process.exit(1);
}
console.log(`渠道 ${gpt.name} → ${gpt.image_model} @ ${gpt.base_url}`);

const OUT = path.join(root, "apps/web/public/previews");
const TASKS: Array<{ group: string; file: string; prompt: string }> = [
  // ── 内容类型效果示意(9)──
  { group: "types", file: "knowledge_cards.png", prompt: "小红书科普知识卡片封面设计样张,深色背景,超大标题『为什么天空是蓝色的』居中,简洁现代排版,一条白色高光曲线点缀,竖版 3:4,高级感,无水印" },
  { group: "types", file: "comic_story.png", prompt: "四格科普漫画样张,可爱短发向导角色在四格中讲解地球大气,清晰勾线,浅色背景,对话框,小红书竖版 3:4,无水印" },
  { group: "types", file: "quote_cards.png", prompt: "极简金句卡片设计样张,米白纸底,一句中文金句用大号衬线字居中,大量留白,角落小红书账号签名,竖版 3:4,无水印" },
  { group: "types", file: "checklist_cards.png", prompt: "小红书清单攻略卡片设计样张,标题『新手入门 5 步走』,编号步骤列表排版,图标点缀,清爽配色,竖版 3:4,无水印" },
  { group: "types", file: "comparison_cards.png", prompt: "小红书对比测评卡片设计样张,左右两栏对齐表格对比两款产品,顶部大标题,单元格图标,商业插画风,竖版 3:4,无水印" },
  { group: "types", file: "product_showcase.png", prompt: "小红书产品种草图文样张,上方产品特写照片(香薰蜡烛),下方卖点标注与价格标签,明亮高级商业风,竖版 3:4,无水印" },
  { group: "types", file: "book_recommendations.png", prompt: "图书推荐卡片设计样张,中央一本精装书插画,配一句书中金句与作者署名,暖纸质感,书卷气,竖版 3:4,无水印" },
  { group: "types", file: "article_digest.png", prompt: "长文要点拆解信息卡设计样张,杂志信息图风格,结构化要点分块排版,序号与分隔线,莫兰迪配色,竖版 3:4,无水印" },
  { group: "types", file: "strip_comic.png", prompt: "四格条漫样张,起承转合讲述一个冷知识笑话,简约黑白勾线加一点橙色,竖版 3:4,无水印" },
  // ── 品牌手册风格样张(6)──
  { group: "brands", file: "darkroom.png", prompt: "小红书图文卡片样张,深色背景,琥珀色点缀,胶片颗粒质感,大标题『暗房工作室』风格示范,电影感,竖版 3:4,无水印" },
  { group: "brands", file: "paper_minimal.png", prompt: "小红书图文卡片样张,米白纸底,大量留白,细线分隔,极简排版,标题『纸感极简』风格示范,竖版 3:4,无水印" },
  { group: "brands", file: "high_contrast.png", prompt: "小红书图文卡片样张,纯黑背景,高饱和亮色强调,超大冲击力标题『高对比营销』风格示范,竖版 3:4,无水印" },
  { group: "brands", file: "morandi.png", prompt: "小红书图文卡片样张,低饱和莫兰迪灰调,柔和自然光,生活场景静物,温柔排版,标题『莫兰迪生活』风格示范,竖版 3:4,无水印" },
  { group: "brands", file: "tech_dark.png", prompt: "小红书图文卡片样张,深蓝科技感背景,发光线条与粒子,未来感排版,标题『科技深色』风格示范,竖版 3:4,无水印" },
  { group: "brands", file: "book_paper.png", prompt: "小红书图文卡片样张,暖纸质感,书卷气插画(翻开的书与茶),柔和阴影,标题『图书纸张』风格示范,竖版 3:4,无水印" },
];

fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2];
for (const task of TASKS) {
  const file = path.join(OUT, task.group, task.file);
  if (only && !`${task.group}/${task.file}`.includes(only)) continue;
  if (fs.existsSync(file)) {
    console.log("跳过(已存在):", task.group + "/" + task.file);
    continue;
  }
  const base = gpt.base_url.replace(/\/$/, "");
  const apiRoot = base.endsWith("/v1") ? base : `${base}/v1`;
  const res = await fetch(`${apiRoot}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gpt.apiKey}` },
    body: JSON.stringify({ model: gpt.image_model, prompt: task.prompt, size: "1024x1536", n: 1 }),
  });
  if (!res.ok) {
    console.error(`FAIL ${task.group}/${task.file}: HTTP ${res.status}`, (await res.text()).slice(0, 200));
    continue;
  }
  const data = (await res.json()) as { data: Array<{ b64_json?: string; url?: string }> };
  const item = data.data[0];
  let bytes: Buffer;
  if (item.b64_json) bytes = Buffer.from(item.b64_json, "base64");
  else if (item.url) bytes = Buffer.from(await (await fetch(item.url)).arrayBuffer());
  else throw new Error("no image payload");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  console.log("OK:", task.group + "/" + task.file, Math.round(bytes.length / 1024) + "KB");
}
console.log("done");
