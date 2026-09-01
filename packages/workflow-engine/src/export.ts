import JSZip from "jszip";
import { z } from "zod";
import type { TextModel } from "@aai/ai-core";
import type { CreateRunInput } from "@aai/shared-schemas";

export interface ExportPageFile {
  index: number;
  role: string;
  headline: string;
  body: string[];
  filename: string;
  buffer: Buffer;
  expectedCopy?: string[];
}

export interface PlatformCopy {
  title: string;
  body: string;
  tags: string[];
  source: "llm" | "template";
}

export const PlatformCopySchema = z.object({
  title: z.string().min(1).max(60),
  body: z.string().min(1),
  tags: z.array(z.string()).min(1).max(12),
});

/** 用文本渠道生成平台发布文案；失败时由调用方降级模板 */
export async function generatePlatformCopy(
  textModel: TextModel,
  input: CreateRunInput,
  pages: ExportPageFile[],
): Promise<PlatformCopy> {
  const outline = pages
    .map((page) => `第${page.index + 1}页（${page.role}）：${page.headline}${page.body.length ? ` — ${page.body.join("；")}` : ""}`)
    .join("\n");
  const result = await textModel.generateObject({
    schemaName: "PlatformCopy",
    schema: PlatformCopySchema,
    prompt: [
      `主题：${input.topic}`,
      `目标平台：${input.platform}`,
      "任务：为这套图文生成发布文案。",
      "要求：标题带钩子、不超过 20 字；正文 100–200 字、口语化、结尾有互动引导；标签 5–8 个、带话题格式。",
      "页面大纲：",
      outline,
    ].join("\n"),
    temperature: 0.6,
  });
  return { ...result, source: "llm" };
}

/** LLM 不可用时的模板文案降级 */
export function templateCopy(
  input: CreateRunInput,
  pages: Array<Pick<ExportPageFile, "index" | "role" | "headline">>,
  coreMessage: string | undefined,
): PlatformCopy {
  const title = input.topic.slice(0, 20);
  const body = [
    coreMessage ? `${coreMessage}` : input.topic,
    "",
    pages
      .slice(1, -1)
      .map((page) => `· ${page.headline}`)
      .join("\n"),
    "",
    "觉得有用的话，点赞收藏，评论区聊聊你的看法。",
  ]
    .filter(Boolean)
    .join("\n");
  return { title, body, tags: ["#干货分享", "#知识科普", "#收藏备用"], source: "template" };
}

export function renderCopyMarkdown(
  input: { topic: string; platform: string; aspectRatio?: string },
  copy: PlatformCopy,
): string {
  return [
    `# ${copy.title}`,
    "",
    copy.body,
    "",
    copy.tags.join(" "),
    "",
    "---",
    `平台：${input.platform} · 比例：${input.aspectRatio} · 文案来源：${copy.source === "llm" ? "模型生成" : "模板"}`,
  ].join("\n");
}

export interface ExportCoverFile {
  assetId: string;
  /** 封面钩子标题（来自资产 metadata，缺省 undefined） */
  hookTitle?: string | undefined;
  filename: string;
  buffer: Buffer;
}

/**
 * 组装导出 ZIP：按序图片 + 发布文案 Markdown + manifest + 发布清单。
 * 文件名用「序号-页码-角色」，保证解压后的排序即发布顺序。
 * 选中封面时作为 images/00-封面.png 置于首张（正文仍从 01 起）。
 */
export async function buildExportZip(input: {
  runId: string;
  topic: string;
  storyboard: { title: string; platform: string; aspectRatio: string };
  pages: ExportPageFile[];
  copy: PlatformCopy;
  manifest: Record<string, unknown>;
  /** 用户挑选的作品封面（可选；无选中封面时零行为变化） */
  cover?: ExportCoverFile | undefined;
}): Promise<Buffer> {
  const zip = new JSZip();
  const images = zip.folder("images")!;

  if (input.cover) {
    images.file("00-封面.png", input.cover.buffer);
  }

  const ordered = [...input.pages].sort((a, b) => a.index - b.index);
  ordered.forEach((page, order) => {
    const no = String(order + 1).padStart(2, "0");
    const ext = page.filename.endsWith(".jpg") || page.filename.endsWith(".jpeg") ? "jpg" : "png";
    images.file(`${no}-${page.role}-${page.headline.slice(0, 16).replace(/[\\/:*?"<>|]/g, "")}.${ext}`, page.buffer);
  });

  zip.file("发布文案.md", renderCopyMarkdown({ topic: input.topic, platform: input.storyboard.platform, aspectRatio: input.storyboard.aspectRatio }, input.copy));
  zip.file("manifest.json", JSON.stringify(input.manifest, null, 2));
  zip.file(
    "发布清单.txt",
    [
      `作品：${input.storyboard.title}`,
      `Run：${input.runId}`,
      `平台：${input.storyboard.platform}（${input.storyboard.aspectRatio}）`,
      `页数：${ordered.length}`,
      "",
      "发布步骤：",
      `1. 按顺序上传 images/ 目录中的图片（文件名序号即顺序${input.cover ? "，00 为封面" : ""}）`,
      "2. 粘贴 发布文案.md 中的标题、正文与标签",
      `3. 首图建议使用 ${input.cover ? "00（封面）" : "01"} 文件；发布前确认图片顺序与内容`,
      "",
      "生成信息见 manifest.json（模型、Prompt 版本、用量与资产血缘）。",
    ].join("\n"),
  );

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
