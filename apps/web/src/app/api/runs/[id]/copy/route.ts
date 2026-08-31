import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { normalizeSlideIndices } from "@aai/shared-schemas";
import type { CreateRunInput, Storyboard } from "@aai/shared-schemas";
import { StoryboardSchema } from "@aai/shared-schemas";
import { generatePlatformCopy, PlatformCopySchema, templateCopy, type PlatformCopy } from "@aai/workflow-engine";
import type { ExportPageFile } from "@aai/workflow-engine";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * 发布文案（详情页展示用）：
 * - 默认（无参）：优先读取 /data/exports/{runId}/copy.json，首次访问才生成并保存模板文案；
 * - ?mode=llm：preferredTextModel 存在时 generatePlatformCopy（20s 超时保护），
 *   成功后更新缓存；失败 / 无模型 / 超时优先返回已有缓存，否则降级并保存模板文案。
 * 与导出 ZIP 共用 copy.json，避免进入详情页时重复组装文案。
 */

function readCopyCache(copyPath: string): PlatformCopy | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(copyPath, "utf8")) as unknown;
    const result = PlatformCopySchema.safeParse(parsed);
    if (!result.success || typeof parsed !== "object" || parsed === null) return null;
    const source = (parsed as { source?: unknown }).source;
    if (source !== "llm" && source !== "template") return null;
    return { ...result.data, source };
  } catch {
    return null;
  }
}

function writeCopyCache(copyPath: string, copy: PlatformCopy): void {
  const tempPath = `${copyPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(copy, null, 2));
    fs.renameSync(tempPath, copyPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
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

  // Storyboard（照抄 export 路由的解析方式）
  const storyboardNode = (await runtime.runRepo.listNodeRuns(id)).find(
    (n) => n.nodeName === "generate-storyboard" && n.status === "succeeded",
  );
  if (!storyboardNode?.outputRef) {
    return NextResponse.json({ error: "storyboard missing" }, { status: 409 });
  }
  const storyboard = normalizeSlideIndices(
    (JSON.parse(storyboardNode.outputRef) as { value: unknown }).value as Storyboard,
  );
  const parsedStoryboard = StoryboardSchema.safeParse(storyboard);
  if (!parsedStoryboard.success) {
    return NextResponse.json({ error: "storyboard invalid" }, { status: 409 });
  }

  const input = JSON.parse(run.inputJson) as CreateRunInput;
  // 文案只依赖 storyboard 文本，无需读取图片 buffer
  const pages: ExportPageFile[] = parsedStoryboard.data.slides.map((slide) => ({
    index: slide.index,
    role: slide.role,
    headline: slide.headline,
    body: slide.body,
    filename: "",
    buffer: Buffer.alloc(0),
  }));

  const exportDir = path.join(runtime.config.exportsDir, id);
  fs.mkdirSync(exportDir, { recursive: true });
  const copyPath = path.join(exportDir, "copy.json");
  const cachedCopy = readCopyCache(copyPath);
  const wantsLlm = new URL(request.url).searchParams.get("mode") === "llm";
  if (wantsLlm) {
    const textModel = runtime.preferredTextModel();
    if (textModel) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const copy = await Promise.race([
          generatePlatformCopy(textModel, input, pages),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("platform copy timeout")), 20_000);
          }),
        ]);
        clearTimeout(timer);
        writeCopyCache(copyPath, copy);
        return NextResponse.json(copy);
      } catch {
        clearTimeout(timer);
        // 超时 / 失败 → 降级模板文案
      }
    }
    if (cachedCopy) return NextResponse.json(cachedCopy);
  }

  if (cachedCopy) return NextResponse.json(cachedCopy);

  // 模板文案：需要 brief 节点的 coreMessage（与 export 路由同模式）
  const briefNode = (await runtime.runRepo.listNodeRuns(id)).find((n) => n.nodeName === "generate-brief");
  const coreMessage = briefNode?.outputRef
    ? (JSON.parse(briefNode.outputRef) as { value?: { coreMessage?: string } }).value?.coreMessage
    : undefined;
  const copy = templateCopy(input, pages, coreMessage);
  writeCopyCache(copyPath, copy);
  return NextResponse.json(copy);
}
