import fs from "node:fs";
import JSZip from "jszip";
import { z } from "zod";
import type { TextModel } from "@aai/ai-core";
import {
  PLATFORM_PRESETS,
  type AdaptPlatform,
  type AspectRatio,
  type CreateRunInput,
  type Storyboard,
} from "@aai/shared-schemas";
import { renderSlideDeterministic, themeById } from "@aai/render-engine";
import type { AssetRepo, AssetStore } from "@aai/storage";

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

/** LLM 不可用时的模板文案降级（只需页序与标题，平台适配包直接传 Storyboard 页） */
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

/**
 * 组装导出 ZIP：按序图片 + 发布文案 Markdown + manifest + 发布清单。
 * 文件名用「序号-页码-角色」，保证解压后的排序即发布顺序。
 */
export async function buildExportZip(input: {
  runId: string;
  topic: string;
  storyboard: { title: string; platform: string; aspectRatio: string };
  pages: ExportPageFile[];
  copy: PlatformCopy;
  manifest: Record<string, unknown>;
}): Promise<Buffer> {
  const zip = new JSZip();
  const images = zip.folder("images")!;

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
      "1. 按顺序上传 images/ 目录中的图片（文件名序号即顺序）",
      "2. 粘贴 发布文案.md 中的标题、正文与标签",
      "3. 首图建议使用 01 文件；发布前确认图片顺序与内容",
      "",
      "生成信息见 manifest.json（模型、Prompt 版本、用量与资产血缘）。",
    ].join("\n"),
  );

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/* ── 多平台一键适配：确定性模式零模型费用重排 ─────────────────── */

/** 适配包单页产物（仅存在于导出 ZIP，不写 assets 表） */
export interface AdaptedPageFile {
  index: number;
  role: string;
  headline: string;
  filename: string;
  buffer: Buffer;
}

export interface PlatformAdaptationDeps {
  assetRepo: AssetRepo;
  assetStore: AssetStore;
}

export interface BuildPlatformAdaptationArgs {
  runId: string;
  input: CreateRunInput;
  storyboard: Storyboard;
  targetPlatform: AdaptPlatform;
}

export interface PlatformAdaptationResult {
  targetPlatform: AdaptPlatform;
  targetAspect: AspectRatio;
  /** 目标比例与原始比例一致时为 true（无需适配，直接用现有导出） */
  skipped: boolean;
  reason?: "same-aspect";
  pages: AdaptedPageFile[];
  /** 缺视觉层被跳过的页（按页序） */
  missingPages: number[];
}

/**
 * 取该页最新 generated 视觉层（与 rerender 路由同模式）：
 * latestForPage 可能返回 composite（确定性合成本身未 supersede 时是"最新"），
 * 重排必须基于无文字的视觉层；连续 rerender 会把整页资产置为 superseded，
 * 此时回退到该页最新 generated 资产。
 */
async function latestVisualAsset(
  deps: PlatformAdaptationDeps,
  runId: string,
  pageIndex: number,
) {
  const latest = await deps.assetRepo.latestForPage(runId, pageIndex);
  if (latest && latest.kind === "generated") return latest;
  const rows = await deps.assetRepo.listByRun(runId);
  const generated = rows
    .filter((row) => row.pageIndex === pageIndex && row.kind === "generated")
    .sort((a, b) => b.createdAt - a.createdAt);
  return (
    generated.find((row) => row.supersededAt === null) ?? generated[0]
  );
}

/**
 * 把已完成的确定性作品重排到目标平台比例：
 * 逐页取 generated 视觉层 → renderSlideDeterministic 按目标比例重新排版。
 * 纯导出产物：不调用模型（零费用），也不写 assets 表（不污染资产链）。
 */
export async function buildPlatformAdaptation(
  deps: PlatformAdaptationDeps,
  args: BuildPlatformAdaptationArgs,
): Promise<PlatformAdaptationResult> {
  const { runId, input, storyboard, targetPlatform } = args;
  const targetAspect = PLATFORM_PRESETS[targetPlatform].aspectRatio;
  if (targetAspect === input.aspectRatio) {
    return {
      targetPlatform,
      targetAspect,
      skipped: true,
      reason: "same-aspect",
      pages: [],
      missingPages: [],
    };
  }

  const pages: AdaptedPageFile[] = [];
  const missingPages: number[] = [];
  for (const slide of storyboard.slides) {
    const visualAsset = await latestVisualAsset(deps, runId, slide.index);
    if (!visualAsset) {
      missingPages.push(slide.index);
      continue;
    }
    const visualPath = deps.assetStore.resolve(visualAsset.filePath);
    if (!fs.existsSync(visualPath)) {
      missingPages.push(slide.index);
      continue;
    }
    const visualImageBase64 = fs.readFileSync(visualPath).toString("base64");
    // Logo 缺失或读取失败时容忍降级（与流水线 readLogoBase64 一致）
    const logoBase64 = input.brandKit?.logoAssetId
      ? await (async () => {
          try {
            return fs
              .readFileSync(deps.assetStore.resolve((await deps.assetRepo.require(input.brandKit!.logoAssetId!)).filePath))
              .toString("base64");
          } catch {
            return undefined;
          }
        })()
      : undefined;

    const buffer = await renderSlideDeterministic({
      theme: themeById(input.brandKit?.themeId),
      aspectRatio: targetAspect,
      slide,
      pageCount: storyboard.slides.length,
      visualImageBase64,
      logoBase64,
      brand: input.brandKit,
    });
    pages.push({
      index: slide.index,
      role: slide.role,
      headline: slide.headline,
      filename: `page-${slide.index}.png`,
      buffer,
    });
  }

  return { targetPlatform, targetAspect, skipped: false, pages, missingPages };
}

/**
 * 组装适配包 ZIP：按序图片 + 发布文案（模板）+ manifest。
 * manifest 记录目标平台/比例与跳过页，便于发布端核对。
 */
export async function buildAdaptationZip(input: {
  runId: string;
  topic: string;
  targetPlatform: AdaptPlatform;
  targetAspect: string;
  pages: AdaptedPageFile[];
  missingPages: number[];
  copy: PlatformCopy;
}): Promise<Buffer> {
  const zip = new JSZip();
  const images = zip.folder("images")!;

  const ordered = [...input.pages].sort((a, b) => a.index - b.index);
  ordered.forEach((page, order) => {
    const no = String(order + 1).padStart(2, "0");
    const ext = page.filename.endsWith(".jpg") || page.filename.endsWith(".jpeg") ? "jpg" : "png";
    images.file(`${no}-${page.role}-${page.headline.slice(0, 16).replace(/[\\/:*?"<>|]/g, "")}.${ext}`, page.buffer);
  });

  zip.file("发布文案.md", renderCopyMarkdown({ topic: input.topic, platform: PLATFORM_PRESETS[input.targetPlatform].label, aspectRatio: input.targetAspect }, input.copy));
  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        runId: input.runId,
        targetPlatform: input.targetPlatform,
        targetAspect: input.targetAspect,
        missingPages: input.missingPages,
        copySource: input.copy.source,
        exportedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
