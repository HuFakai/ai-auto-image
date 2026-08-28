import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import JSZip from "jszip";
import type { Storyboard } from "@aai/shared-schemas";
import { exportRoot, getDb } from "./db";
import { assets, projects } from "./db/schema";
import { newId } from "@aai/ai-core";
import { PLATFORM_SPEC } from "./recipes";
import type { Platform } from "@aai/shared-schemas";

export interface ExportResult {
  exportId: string;
  assetId: string;
  zipPath: string;
  fileCount: number;
}

/**
 * Build the publish package: ordered page images + platform copy markdown +
 * generation info. Deterministic, no AI calls.
 */
export async function exportProject(projectId: string): Promise<ExportResult> {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error("project not found");
  const storyboard = project.storyboard ? (JSON.parse(project.storyboard) as Storyboard) : null;
  if (!storyboard) throw new Error("project has no storyboard");

  const rows = db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, projectId), eq(assets.deleted, 0)))
    .all();
  const bySlide = new Map<number, string>();
  for (const a of rows) {
    if (a.slideIndex === null || a.slideIndex === undefined) continue;
    // prefer the highest revision composite/native for each slide
    const meta = a.meta ? (JSON.parse(a.meta) as { revision?: number }) : {};
    const prev = bySlide.get(a.slideIndex);
    if (!prev) bySlide.set(a.slideIndex, a.id);
    else {
      const prevAsset = rows.find((r) => r.id === prev);
      const prevRev = prevAsset?.meta ? (JSON.parse(prevAsset.meta) as { revision?: number }).revision ?? 0 : 0;
      if ((meta.revision ?? 0) >= prevRev) bySlide.set(a.slideIndex, a.id);
    }
  }

  const zip = new JSZip();
  const ordered = [...bySlide.entries()].sort((a, b) => a[0] - b[0]);
  const imageFiles: string[] = [];
  for (const [idx, assetId] of ordered) {
    const asset = rows.find((r) => r.id === assetId);
    if (!asset) continue;
    const ext = asset.mimeType.includes("png") ? "png" : "jpg";
    const name = `${String(idx + 1).padStart(2, "0")}_${storyboard.slides[idx]?.role ?? "page"}.${ext}`;
    zip.file(name, await readFile(asset.path));
    imageFiles.push(name);
  }

  const spec = PLATFORM_SPEC[project.platform as Platform];
  const copy = [
    `# ${storyboard.title}`,
    "",
    `> 平台：${spec?.label ?? project.platform} ｜ 比例：${project.aspectRatio} ｜ 文字模式：${project.textRenderingMode}`,
    "",
    "## 发布标题",
    "",
    project.selectedTitle ?? storyboard.title,
    "",
    "## 发布正文",
    "",
    (project.brief ? (JSON.parse(project.brief) as { callToAction?: string }).callToAction : "") ?? "",
    storyboard.slides
      .map((s, i) => `${i + 1}. **${s.headline}**${s.body.length ? ` — ${s.body.join("；")}` : ""}`)
      .join("\n"),
    "",
    "## 发布清单",
    "",
    `- 图片数量：${imageFiles.length}`,
    "- [ ] 已人工核对每页中文文字（原生模式必查）",
    "- [ ] 已核对价格与商品参数与输入一致",
    "- [ ] 确认无绝对化用语与违禁表达",
    "- [ ] 选择发布账号并确认授权",
    "",
    "## 生成信息",
    "",
    `- 项目 ID：${projectId}`,
    `- 生成时间：${new Date().toISOString()}`,
    `- Recipe：${project.recipeId}`,
    `- 模型：文本 ${process.env.TEXT_PROVIDER_MODEL ?? "-"} / 图片 ${process.env.IMAGE_PROVIDER_MODEL ?? "-"}`,
  ].join("\n");
  zip.file("发布文案.md", copy);

  const exportId = newId("exp");
  const dir = path.join(exportRoot(), projectId);
  await mkdir(dir, { recursive: true });
  const zipPath = path.join(dir, `${exportId}.zip`);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(zipPath, buf);

  const exportAssetId = newId("asset");
  db.insert(assets)
    .values({
      id: exportAssetId,
      projectId,
      kind: "export",
      path: zipPath,
      mimeType: "application/zip",
      bytes: buf.length,
      meta: JSON.stringify({ exportId, fileCount: imageFiles.length + 1 }),
    })
    .run();

  return { exportId, zipPath, fileCount: imageFiles.length + 1, assetId: exportAssetId };
}

export function findExportPath(projectId: string, exportId: string): string | null {
  const db = getDb();
  const row = db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, projectId), eq(assets.kind, "export")))
    .all()
    .find((r) => (r.meta ? (JSON.parse(r.meta) as { exportId?: string }).exportId === exportId : false));
  return row?.path ?? null;
}
