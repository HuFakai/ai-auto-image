import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { normalizeSlideIndices } from "@aai/shared-schemas";
import type { CreateRunInput, Storyboard } from "@aai/shared-schemas";
import { StoryboardSchema } from "@aai/shared-schemas";
import { buildExportZip, generatePlatformCopy, templateCopy, type ExportCoverFile, type ExportPageFile } from "@aai/workflow-engine";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";

export const dynamic = "force-dynamic";

/** 导出 ZIP：按序图片 + 发布文案 + manifest + 发布清单；结果缓存到 /data/exports */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runtime = await getRuntime();
  let run;
  try {
    run = await runtime.runRepo.require(id);
  } catch {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  if (run.userId && run.userId !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (run.status !== "succeeded") {
    return NextResponse.json({ error: "run not finished" }, { status: 409 });
  }

  const input = JSON.parse(run.inputJson) as CreateRunInput;

  // Storyboard（标题与页序）
  const storyboardNode = (await runtime.runRepo.listNodeRuns(id)).find(
    (n) => n.nodeName === "generate-storyboard" && n.status === "succeeded",
  );
  if (!storyboardNode?.outputRef) {
    return NextResponse.json({ error: "storyboard missing" }, { status: 409 });
  }
  // LLM 可能输出 1-based 页码：按数组下标归一化，与图片资产对齐
  const storyboard = normalizeSlideIndices(
    (JSON.parse(storyboardNode.outputRef) as { value: unknown }).value as Storyboard,
  );
  const parsedStoryboard = StoryboardSchema.safeParse(storyboard);
  if (!parsedStoryboard.success) {
    return NextResponse.json({ error: "storyboard invalid" }, { status: 409 });
  }

  // 页面当前版本资产（未被替代），按页序排列
  const pageFiles: ExportPageFile[] = [];
  for (const slide of parsedStoryboard.data.slides) {
    const asset = await runtime.assetRepo.latestForPage(id, slide.index);
    if (!asset) continue;
    const fullPath = runtime.assetStore.resolve(asset.filePath);
    if (!fs.existsSync(fullPath)) continue;
    pageFiles.push({
      index: slide.index,
      role: slide.role,
      headline: slide.headline,
      body: slide.body,
      filename: path.basename(asset.filePath),
      buffer: fs.readFileSync(fullPath),
      expectedCopy: (() => {
        try {
          return (JSON.parse(asset.metadataJson ?? "{}") as { expectedCopy?: string[] }).expectedCopy;
        } catch {
          return undefined;
        }
      })(),
    });
  }
  if (pageFiles.length === 0) {
    return NextResponse.json({ error: "no pages to export" }, { status: 409 });
  }

  // 选中封面（可选）：作为 ZIP 首张 images/00-封面.png；资产缺失或读取失败时零影响
  let coverFile: ExportCoverFile | undefined;
  if (run.selectedCoverAssetId) {
    try {
      const coverAsset = await runtime.assetRepo.require(run.selectedCoverAssetId);
      if (coverAsset.kind === "cover") {
        const coverPath = runtime.assetStore.resolve(coverAsset.filePath);
        if (fs.existsSync(coverPath)) {
          const coverMeta = (() => {
            try {
              return JSON.parse(coverAsset.metadataJson ?? "{}") as { hookTitle?: string };
            } catch {
              return {} as { hookTitle?: string };
            }
          })();
          coverFile = {
            assetId: coverAsset.id,
            hookTitle: coverMeta.hookTitle,
            filename: path.basename(coverAsset.filePath),
            buffer: fs.readFileSync(coverPath),
          };
        }
      }
    } catch {
      coverFile = undefined;
    }
  }

  // 发布文案：优先复用缓存；否则用文本渠道生成（失败降级模板）
  const exportDir = path.join(runtime.config.exportsDir, id);
  fs.mkdirSync(exportDir, { recursive: true });
  const copyPath = path.join(exportDir, "copy.json");
  let copy: ReturnType<typeof templateCopy>;
  if (fs.existsSync(copyPath)) {
    copy = JSON.parse(fs.readFileSync(copyPath, "utf8"));
  } else {
    const textModel = runtime.preferredTextModel();
    try {
      if (!textModel) throw new Error("no text model");
      copy = await generatePlatformCopy(textModel, input, pageFiles);
    } catch {
      const briefNode = (await runtime.runRepo.listNodeRuns(id)).find((n) => n.nodeName === "generate-brief");
      const coreMessage = briefNode?.outputRef
        ? (JSON.parse(briefNode.outputRef) as { value?: { coreMessage?: string } }).value?.coreMessage
        : undefined;
      copy = templateCopy(input, pageFiles, coreMessage);
    }
    fs.writeFileSync(copyPath, JSON.stringify(copy, null, 2));
  }

  const manifest = JSON.parse(
    fs.existsSync(path.join(exportDir, "manifest.json"))
      ? fs.readFileSync(path.join(exportDir, "manifest.json"), "utf8")
      : "{}",
  ) as Record<string, unknown>;

  const zip = await buildExportZip({
    runId: id,
    topic: input.topic,
    storyboard: {
      title: parsedStoryboard.data.title,
      platform: parsedStoryboard.data.platform,
      aspectRatio: parsedStoryboard.data.aspectRatio,
    },
    pages: pageFiles,
    copy,
    cover: coverFile,
    manifest: {
      ...manifest,
      exportedAt: new Date().toISOString(),
      copySource: copy.source,
      ...(coverFile ? { cover: { assetId: coverFile.assetId, hookTitle: coverFile.hookTitle } } : {}),
    },
  });

  return new Response(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="export-${id.slice(4, 12)}.zip"`,
    },
  });
}
