/** 一次性：对指定漫画 run 用当前配色重新合成气泡层并更新资产 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sqlite3 from "better-sqlite3";
import { renderComicSlide, themeById } from "@aai/render-engine";

const runId = process.argv[2];
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), "apps/web/data");
const db = new sqlite3(path.join(dataDir, "db", "app.db"));

const sbRow = db
  .prepare(
    "SELECT output_ref FROM node_runs WHERE run_id=? AND node_name='generate-comic-storyboard' AND status='succeeded'",
  )
  .get(runId) as { output_ref: string } | undefined;
if (!sbRow) throw new Error("storyboard not found");
const storyboard = (JSON.parse(sbRow.output_ref) as { value: {
  title: string;
  pages: Array<{ index: number; scene: string; dialogues: Array<{ speaker: string; text: string; type: string }> }>;
} }).value;

const inputRow = db.prepare("SELECT input_json FROM workflow_runs WHERE id=?").get(runId) as { input_json: string };
const input = JSON.parse(inputRow.input_json) as { aspectRatio: string; brandKit?: { themeId?: string; logoAssetId?: string } };

const assetStoreDir = path.join(dataDir, "assets");
const update = db.prepare("UPDATE assets SET bytes=?, checksum=? WHERE id=?");

for (const page of storyboard.pages) {
  const row = db
    .prepare(
      "SELECT id, file_path, metadata_json, node_run_id FROM assets WHERE run_id=? AND page_index=? AND kind='composite' AND superseded_at IS NULL",
    )
    .get(runId, page.index) as { id: string; file_path: string; metadata_json: string; node_run_id: string } | undefined;
  if (!row) continue;
  const panelPath = row.file_path.replace("-composite.png", ".png");
  const panel = fs.readFileSync(panelPath);
  const buffer = await renderComicSlide({
    theme: themeById(input.brandKit?.themeId),
    aspectRatio: input.aspectRatio as "3:4",
    panelImageBase64: panel.toString("base64"),
    title: storyboard.title,
    pageIndex: page.index,
    pageCount: storyboard.pages.length,
    dialogues: page.dialogues as Array<{ speaker: string; text: string; type: "speech" | "narration" }>,
  });
  fs.writeFileSync(row.file_path, buffer);
  update.run(
    buffer.length,
    createHash("sha256").update(buffer).digest("hex"),
    row.id,
  );
  console.log(`page ${page.index + 1} 重新合成 → ${(buffer.length / 1024).toFixed(0)} KB`);
}
db.close();
