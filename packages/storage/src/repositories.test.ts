import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type OpenDatabase } from "./database";
import {
  AssetRepo,
  BrandKitRepo,
  ChannelModelRepo,
  ChannelRepo,
  InsufficientWalletCreditsError,
  JobRepo,
  LedgerRepo,
  OrderRepo,
  ProjectRepo,
  RunRepo,
  UserRepo,
} from "./repositories";

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

  it("setSelectedCover round-trips the selected cover asset id", async () => {
    const projects = new ProjectRepo(db.db);
    const runs = new RunRepo(db.db);
    const assets = new AssetRepo(db.db);
    const project = await projects.create({ title: "封面选择测试" });
    const run = await runs.create({ projectId: project.id, inputJson: "{}" });

    // 未挑选时为 null
    expect((await runs.require(run.id)).selectedCoverAssetId).toBeNull();

    // 写入并回读（外键约束：须为真实资产）
    const coverAsset = await assets.create({
      runId: run.id,
      pageIndex: -1,
      kind: "cover",
      filePath: "runs/x/covers/cover-1.png",
      bytes: 1,
      metadataJson: JSON.stringify({ purpose: "cover", variant: 1 }),
    });
    const updated = await runs.setSelectedCover(run.id, coverAsset.id);
    expect(updated.selectedCoverAssetId).toBe(coverAsset.id);
    expect((await runs.require(run.id)).selectedCoverAssetId).toBe(coverAsset.id);

    // 传 null 取消选择
    const cleared = await runs.setSelectedCover(run.id, null);
    expect(cleared.selectedCoverAssetId).toBeNull();
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

describe("ChannelModelRepo", () => {
  let db: OpenDatabase;
  beforeAll(async () => {
    db = await openSharedDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("discovers models without overwriting administrator settings", async () => {
    const channels = new ChannelRepo(db.db);
    const models = new ChannelModelRepo(db.db);
    const channel = await channels.create({
      name: `模型目录-${Math.random()}`,
      type: "image",
      baseUrl: "https://api.example.com/v1",
      apiKeyEncrypted: "encrypted",
      apiKeyHint: "••••key",
      imageModel: "gpt-image-2",
      imageEditSupport: 1,
      priority: 9,
      userModelSelectionEnabled: 1,
    });

    await models.ensureLegacyDefault(channel.id, "image", "gpt-image-2", {
      textToImage: true,
      imageEditSingle: true,
      imageEditMulti: true,
    });
    const discovered = await models.discover(channel.id, "image", [
      { providerModelId: "gpt-image-2", displayName: "GPT Image 2" },
      { providerModelId: "grok-imagine-image-2.0", displayName: "Grok Imagine" },
      { providerModelId: "grok-imagine-image-2.0", displayName: "Grok Imagine duplicate" },
    ]);
    expect(discovered).toHaveLength(2);
    expect(discovered.find((row) => row.providerModelId === "gpt-image-2")?.isDefault).toBe(1);

    const saved = await models.saveSettings(channel.id, "image", [
      {
        providerModelId: "gpt-image-2",
        enabled: 1,
        isDefault: 0,
        priority: 2,
        creditsPerCall: 6,
        capabilities: { textToImage: true, imageEditSingle: true, imageEditMulti: true },
      },
      {
        providerModelId: "grok-imagine-image-2.0",
        enabled: 1,
        isDefault: 1,
        priority: 10,
        creditsPerCall: 3,
        capabilities: { textToImage: true, imageEditSingle: false },
      },
    ]);
    expect(saved[0]?.providerModelId).toBe("grok-imagine-image-2.0");
    expect(saved[0]?.isDefault).toBe(1);
    expect(saved[0]?.creditsPerCall).toBe(3);

    const refreshed = await models.discover(channel.id, "image", [
      { providerModelId: "grok-imagine-image-2.0", displayName: "Grok Imagine (updated)" },
    ]);
    const grok = refreshed.find((row) => row.providerModelId === "grok-imagine-image-2.0");
    expect(grok?.displayName).toBe("Grok Imagine (updated)");
    expect(grok?.creditsPerCall).toBe(3);
    expect(grok?.priority).toBe(10);
    expect(grok?.isDefault).toBe(1);
    expect(JSON.parse(grok!.capabilitiesJson)).toEqual({ textToImage: true, imageEditSingle: false });
  });
});

describe("Billing trace and pagination", () => {
  let db: OpenDatabase;
  beforeAll(async () => {
    db = await openSharedDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("keeps work titles in ledger pages and atomically creates admin adjustment orders", async () => {
    const userRepo = new UserRepo(db.db);
    const projectRepo = new ProjectRepo(db.db);
    const runRepo = new RunRepo(db.db);
    const ledgerRepo = new LedgerRepo(db.db);
    const orderRepo = new OrderRepo(db.db);
    const user = await userRepo.create({ username: `trace-user-${Math.random()}`, role: "user" });
    const admin = await userRepo.create({ username: `trace-admin-${Math.random()}`, role: "admin" });
    const project = await projectRepo.create({ title: "作品标题可追溯", userId: user.id });
    const run = await runRepo.create({ projectId: project.id, userId: user.id, inputJson: "{}" });

    await ledgerRepo.append({
      userId: user.id,
      delta: -1,
      balanceAfter: 9,
      reason: "consume",
      runId: run.id,
      refType: "workflow_node",
      refId: "node_trace",
      displayTitle: project.title,
      note: "生图 1 点",
    });
    const granted = await ledgerRepo.applyAdminAdjustment({
      userId: user.id,
      operatorUserId: admin.id,
      delta: 12,
      note: "内测补偿",
      starterCredits: 0,
    });
    for (let index = 1; index <= 9; index += 1) {
      await ledgerRepo.applyAdminAdjustment({
        userId: user.id,
        operatorUserId: admin.id,
        delta: 1,
        note: `批量调整 ${index}`,
        starterCredits: 0,
      });
    }
    const deducted = await ledgerRepo.applyAdminAdjustment({
      userId: user.id,
      operatorUserId: admin.id,
      delta: -5,
      note: "撤回多发点数",
      starterCredits: 0,
    });

    expect(granted.balance).toBe(12);
    expect(deducted.balance).toBe(16);
    expect(granted.orderNo).toMatch(/^ADJ/);
    const ledgerPage = await ledgerRepo.listByUserPage(user.id, 1, 10);
    const ledgerPage2 = await ledgerRepo.listByUserPage(user.id, 2, 10);
    expect(ledgerPage.total).toBe(12);
    const ledgerItems = [...ledgerPage.items, ...ledgerPage2.items];
    expect(ledgerItems.some((row) => row.runId === run.id && row.displayTitle === project.title)).toBe(true);
    expect(ledgerItems.filter((row) => row.reason === "admin_adjust").map((row) => row.displayTitle)).toEqual(
      expect.arrayContaining(["内测补偿", "撤回多发点数"]),
    );

    const orderPage = await orderRepo.listByUserPage(user.id, 1, 10);
    expect(orderPage.total).toBe(11);
    expect(orderPage.totalPages).toBe(2);
    expect(orderPage.items[0]?.type).toBe("admin_adjust");
    expect(orderPage.items[0]?.status).toBe("adjusted");
    expect(orderPage.items[0]?.title).toBe("撤回多发点数");
    expect(orderPage.items[0]?.credits).toBe(-5);
    const adminSearch = await orderRepo.listAdminPage({ q: granted.orderNo, page: 1, pageSize: 10 });
    expect(adminSearch.total).toBe(1);
    expect(adminSearch.items[0]?.orderNo).toBe(granted.orderNo);
    expect((await orderRepo.revenueByChannel()).length).toBe(0);

    await expect(
      ledgerRepo.applyAdminAdjustment({
        userId: user.id,
        operatorUserId: admin.id,
        delta: -17,
        note: "超额扣减",
        starterCredits: 0,
      }),
    ).rejects.toBeInstanceOf(InsufficientWalletCreditsError);
    expect((await orderRepo.listByUserPage(user.id, 1, 20)).total).toBe(11);
  });
});
