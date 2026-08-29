import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type OpenDatabase } from "./database";
import { BrandKitRepo, JobRepo, ProjectRepo, RunRepo } from "./repositories";

function migrationsDir(): string {
  const moduleUrl = import.meta.url;
  return new URL("../drizzle", moduleUrl).pathname;
}

// 每个 describe 共享一个进程内 PGlite（迁移只跑一次），避免并行下 WASM 冷启动抖动
async function openSharedDb(): Promise<OpenDatabase> {
  return openDatabase({ migrationsFolder: migrationsDir() });
}

describe("BrandKitRepo", () => {
  let db: OpenDatabase;
  beforeAll(async () => {
    db = await openSharedDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("round-trips the new brand manual fields on create/update", async () => {
    const repo = new BrandKitRepo(db.db);
    const kit = await repo.create({
      name: "测试品牌",
      themeId: "darkroom",
      styleKeywords: ["插画"],
      negativeKeywords: ["真人照片"],
      brandName: "示例品牌",
      slogan: "让知识有光",
      footerSignature: "@示例账号",
      watermarkText: "示例水印",
      watermarkPosition: "center",
      watermarkOpacity: 0.25,
      titleFont: "serif",
      paletteJson: { primary: "#ff0000", accent: "#00ff00", background: "#ffffff", ink: "#111111" },
      coverLayout: "big-center",
    });

    expect(kit.brandName).toBe("示例品牌");
    expect(kit.slogan).toBe("让知识有光");
    expect(kit.footerSignature).toBe("@示例账号");
    expect(kit.watermarkText).toBe("示例水印");
    expect(kit.watermarkPosition).toBe("center");
    expect(kit.watermarkOpacity).toBeCloseTo(0.25);
    expect(kit.titleFont).toBe("serif");
    expect(JSON.parse(kit.paletteJson!)).toEqual({
      primary: "#ff0000",
      accent: "#00ff00",
      background: "#ffffff",
      ink: "#111111",
    });
    expect(kit.coverLayout).toBe("big-center");

    const updated = await repo.update(kit.id, {
      brandName: "新品牌",
      watermarkText: null,
      watermarkOpacity: 0.1,
      titleFont: "sans",
      paletteJson: { primary: "#0000ff" },
      coverLayout: "split",
    });

    expect(updated.brandName).toBe("新品牌");
    expect(updated.watermarkText).toBeNull();
    expect(updated.watermarkOpacity).toBeCloseTo(0.1);
    expect(updated.titleFont).toBe("sans");
    expect(JSON.parse(updated.paletteJson!)).toEqual({ primary: "#0000ff" });
    expect(updated.coverLayout).toBe("split");
  });

  it("applies column defaults when new fields are omitted", async () => {
    const repo = new BrandKitRepo(db.db);
    const kit = await repo.create({
      name: "默认",
      themeId: "darkroom",
      styleKeywords: [],
      negativeKeywords: [],
    });

    expect(kit.brandName).toBeNull();
    expect(kit.footerSignature).toBeNull();
    expect(kit.watermarkText).toBeNull();
    expect(kit.watermarkPosition).toBe("corner");
    expect(kit.watermarkOpacity).toBeCloseTo(0.18);
    expect(kit.titleFont).toBe("default");
    expect(kit.paletteJson).toBeNull();
    expect(kit.coverLayout).toBe("default");
  });

  it("clears nullable brand kit fields to null on update", async () => {
    const repo = new BrandKitRepo(db.db);
    const kit = await repo.create({
      name: "清空测试",
      themeId: "darkroom",
      styleKeywords: [],
      negativeKeywords: [],
      brandName: "示例品牌",
      slogan: "让知识有光",
      footerSignature: "@示例账号",
      watermarkText: "示例水印",
      logoAssetId: "asset_123",
      paletteJson: { primary: "#ff0000", accent: "#00ff00" },
    });

    const updated = await repo.update(kit.id, {
      brandName: null,
      slogan: null,
      footerSignature: null,
      watermarkText: null,
      logoAssetId: null,
      paletteJson: null,
    });

    expect(updated.brandName).toBeNull();
    expect(updated.slogan).toBeNull();
    expect(updated.footerSignature).toBeNull();
    expect(updated.watermarkText).toBeNull();
    expect(updated.logoAssetId).toBeNull();
    expect(updated.paletteJson).toBeNull();

    // 显式 null 与「不提交」区分：未提交字段保持不变
    const again = await repo.update(updated.id, { brandName: "新品牌" });
    expect(again.brandName).toBe("新品牌");
    expect(again.slogan).toBeNull();
    expect(again.watermarkText).toBeNull();
  });

  it("round-trips palette colors as explicit null (per-color clear)", async () => {
    const repo = new BrandKitRepo(db.db);
    const kit = await repo.create({
      name: "色板清空",
      themeId: "darkroom",
      styleKeywords: [],
      negativeKeywords: [],
      paletteJson: { primary: "#ff0000", accent: "#00ff00", background: "#ffffff", ink: "#111111" },
    });
    const updated = await repo.update(kit.id, {
      paletteJson: { primary: null, accent: "#0000ff", background: null, ink: "#222222" },
    });
    expect(JSON.parse(updated.paletteJson!)).toEqual({
      primary: null,
      accent: "#0000ff",
      background: null,
      ink: "#222222",
    });
  });
});

describe("RunRepo", () => {
  let db: OpenDatabase;
  beforeAll(async () => {
    db = await openSharedDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("does not overwrite terminal status (succeeded/cancelled); non-terminal transitions still flow", async () => {
    const projects = new ProjectRepo(db.db);
    const runs = new RunRepo(db.db);
    const project = await projects.create({ title: "状态测试" });

    const run = await runs.create({ projectId: project.id, inputJson: "{}" });
    expect(await runs.updateStatus(run.id, "succeeded")).toBe(true);
    // succeeded 终态不可被覆盖（返回 false 表示未写入）
    expect(await runs.updateStatus(run.id, "cancelled")).toBe(false);
    expect((await runs.require(run.id)).status).toBe("succeeded");

    const run2 = await runs.create({ projectId: project.id, inputJson: "{}" });
    expect(await runs.updateStatus(run2.id, "running")).toBe(true);
    expect(await runs.updateStatus(run2.id, "awaiting_approval")).toBe(true);
    expect((await runs.require(run2.id)).status).toBe("awaiting_approval");

    // failed 是页失败→Job 重试期间的瞬态：允许 failed → running → succeeded 流转
    const run3 = await runs.create({ projectId: project.id, inputJson: "{}" });
    expect(await runs.updateStatus(run3.id, "failed")).toBe(true);
    expect(await runs.updateStatus(run3.id, "running")).toBe(true);
    expect((await runs.require(run3.id)).status).toBe("running");
  });
});

describe("JobRepo", () => {
  let db: OpenDatabase;
  beforeAll(async () => {
    db = await openSharedDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("protects terminal status from overwrite", async () => {
    const jobs = new JobRepo(db.db);
    const { job } = await jobs.createOrReuse({ kind: "knowledge_card_run" });
    const first = await jobs.updateStatus(job.id, "succeeded");
    expect(first.status).toBe("succeeded");
    // 终态后再次流转是 no-op，返回原行且不写入 lastError
    const second = await jobs.updateStatus(job.id, "failed", { lastError: "boom" });
    expect(second.status).toBe("succeeded");
    expect(second.lastError).toBeNull();
  });

  it("releases stale running jobs back to queued with orphan_recovered event", async () => {
    const jobs = new JobRepo(db.db);
    const { job } = await jobs.createOrReuse({ kind: "knowledge_card_run" });
    const claimed = await jobs.claimNext("holder-a", 60_000);
    expect(claimed?.id).toBe(job.id);
    expect((await jobs.require(job.id)).status).toBe("running");

    expect(await jobs.releaseStaleRunning()).toBe(1);
    const after = await jobs.require(job.id);
    expect(after.status).toBe("queued");
    const events = (await jobs.listEvents(job.id)).map((e) => e.event);
    expect(events).toContain("orphan_recovered");
    // 无 running 遗留时幂等返回 0
    expect(await jobs.releaseStaleRunning()).toBe(0);
  });

  it("finds the most recent job by run id", async () => {
    const jobs = new JobRepo(db.db);
    const project = await new ProjectRepo(db.db).create({ title: "按 run 查 job" });
    const run = await new RunRepo(db.db).create({ projectId: project.id, inputJson: "{}" });
    const first = await jobs.createOrReuse({ kind: "knowledge_card_run", runId: run.id });
    const second = await jobs.createOrReuse({
      kind: "knowledge_card_run",
      runId: run.id,
      idempotencyKey: "run-2",
    });
    const found = await jobs.findByRunId(run.id);
    expect(found?.id).toBe(second.job.id);
    expect(first.job.id).not.toBe(second.job.id);
    expect(await jobs.findByRunId("no-such-run")).toBeNull();
  });
});
