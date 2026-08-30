import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import JSZip from "jszip";
import { fontsPresent } from "@aai/render-engine";
import type { CreateRunInput, Storyboard } from "@aai/shared-schemas";
import { buildExportZip, templateCopy, generateCoverCandidates } from "./index";
import {
  createHarness,
  createRunWith,
  disposeHarness,
  startEvalRunner,
  waitUntil,
  type Harness,
} from "./testkit";

const harnesses: Harness[] = [];

async function makeHarness(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
  const harness = await createHarness(options);
  harnesses.push(harness);
  return harness;
}

afterAll(async () => {
  for (const harness of harnesses) await disposeHarness(harness);
});

async function coverAssetsOf(harness: Harness, runId: string) {
  const rows = await harness.assetRepo.listByRun(runId);
  return rows
    .filter((a) => a.kind === "cover")
    .sort((a, b) => {
      const va = (JSON.parse(a.metadataJson ?? "{}") as { variant?: number }).variant ?? 0;
      const vb = (JSON.parse(b.metadataJson ?? "{}") as { variant?: number }).variant ?? 0;
      return va - vb;
    });
}

/** deterministic 全流程 + 内嵌封面工序（渲染依赖字体） */
describe.skipIf(!fontsPresent())("cover stage in deterministic pipeline (needs fonts)", () => {
  it("produces 3 cover candidates after a successful run; second call is idempotent", async () => {
    const harness = await makeHarness({ mock: { latencyMs: 1 } });
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, {
      topic: "什么是复利",
      textRenderingMode: "deterministic",
    });
    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded", 30_000);
    await runner.stop();

    const run = await harness.runRepo.require(runId);
    expect(run.status).toBe("succeeded");

    // 管线内嵌封面工序：3 个候选落库（kind=cover、pageIndex=-1、metadata 带 variant/hookTitle）
    const covers = await coverAssetsOf(harness, runId);
    expect(covers).toHaveLength(3);
    covers.forEach((cover, index) => {
      expect(cover.pageIndex).toBe(-1);
      const meta = JSON.parse(cover.metadataJson ?? "{}") as {
        purpose?: string;
        variant?: number;
        hookTitle?: string;
        styleNote?: string;
        mode?: string;
      };
      expect(meta.purpose).toBe("cover");
      expect(meta.variant).toBe(index + 1);
      expect(meta.hookTitle?.length).toBeGreaterThan(0);
      expect(meta.styleNote?.length).toBeGreaterThan(0);
      expect(meta.mode).toBe("deterministic");
    });
    // 封面文件真实落盘
    for (const cover of covers) {
      expect(fs.existsSync(harness.coverDeps.assetStore.resolve(cover.filePath))).toBe(true);
    }

    // generate-covers 节点成功
    const nodes = await harness.runRepo.listNodeRuns(runId);
    const coverNode = nodes.find((n) => n.nodeName === "generate-covers");
    expect(coverNode?.status).toBe("succeeded");

    // 共享函数幂等：已有 succeeded 节点时整体跳过，资产数不变
    const input = JSON.parse(run.inputJson) as CreateRunInput;
    const storyboardNode = nodes.find((n) => n.nodeName === "generate-storyboard" && n.status === "succeeded")!;
    const storyboard = (JSON.parse(storyboardNode.outputRef!) as { value: Storyboard }).value;
    const result = await generateCoverCandidates(harness.coverDeps, {
      runId,
      input,
      storyboard,
      ctx: { signal: new AbortController().signal, onProgress: () => {} },
    });
    expect(result.skipped).toBe(true);
    expect(await coverAssetsOf(harness, runId)).toHaveLength(3);
  }, 60_000);

  it("keeps other candidates when one cover image fails", async () => {
    let coverImageCalls = 0;
    const harness = await makeHarness({
      mock: {
        latencyMs: 1,
        // 第 1 个候选的封面图调用失败（封面 Prompt 含「封面主视觉」，正文页不含）
        shouldFailImage: (request) => {
          if (!request.prompt.includes("封面主视觉")) return false;
          coverImageCalls += 1;
          return coverImageCalls === 1;
        },
      },
    });
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, {
      topic: "时间管理方法",
      textRenderingMode: "deterministic",
    });
    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded", 30_000);
    await runner.stop();

    // 封面候选 1 失败不阻塞其余：run 仍成功，产出 2 张
    const run = await harness.runRepo.require(runId);
    expect(run.status).toBe("succeeded");
    const covers = await coverAssetsOf(harness, runId);
    expect(covers).toHaveLength(2);

    const nodes = await harness.runRepo.listNodeRuns(runId);
    const coverNode = nodes.find((n) => n.nodeName === "generate-covers")!;
    expect(coverNode.status).toBe("succeeded");
    const output = JSON.parse(coverNode.outputRef ?? "{}") as { produced?: number; failedVariants?: number[] };
    expect(output.produced).toBe(2);
    expect(output.failedVariants).toEqual([1]);
  }, 60_000);
});

describe("cover stage in native pipeline", () => {
  it("produces 3 native cover candidates; plan failure does not fail the run", async () => {
    let planCalls = 0;
    let failedOnce = false;
    const harness = await makeHarness({
      mock: {
        latencyMs: 1,
        // 首次 CoverPlan 计划生成失败（封面 Prompt 含「封面候选方案」）
        shouldFailText: (prompt) => {
          if (!prompt.includes("封面候选方案")) return false;
          planCalls += 1;
          const fail = planCalls === 1;
          failedOnce = failedOnce || fail;
          return fail;
        },
      },
    });
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, { topic: "睡眠科学" });
    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded", 30_000);
    await runner.stop();

    const run = await harness.runRepo.require(runId);
    // LLM 计划失败被吞掉：run 依然成功，封面是增强能力
    expect(failedOnce).toBe(true);
    expect(run.status).toBe("succeeded");
    expect(await coverAssetsOf(harness, runId)).toHaveLength(0);
    const failedNode = (await harness.runRepo.listNodeRuns(runId)).find(
      (n) => n.nodeName === "generate-covers" && n.status === "failed",
    );
    expect(failedNode).toBeDefined();

    // 直接调共享函数（重试路径）：计划成功后 3 个 native 候选落库
    const input = JSON.parse(run.inputJson) as CreateRunInput;
    const storyboardNode = (await harness.runRepo.listNodeRuns(runId)).find(
      (n) => n.nodeName === "generate-storyboard" && n.status === "succeeded",
    )!;
    const storyboard = (JSON.parse(storyboardNode.outputRef!) as { value: Storyboard }).value;
    const result = await generateCoverCandidates(harness.coverDeps, {
      runId,
      input,
      storyboard,
      ctx: { signal: new AbortController().signal, onProgress: () => {} },
    });
    expect(result.skipped).toBe(false);
    expect(result.produced).toBe(3);
    expect(result.failedVariants).toEqual([]);

    const covers = await coverAssetsOf(harness, runId);
    expect(covers).toHaveLength(3);
    for (const cover of covers) {
      expect(cover.pageIndex).toBe(-1);
      const meta = JSON.parse(cover.metadataJson ?? "{}") as { mode?: string; hookTitle?: string };
      expect(meta.mode).toBe("native");
      expect(meta.hookTitle?.length).toBeGreaterThan(0);
      expect(fs.existsSync(harness.coverDeps.assetStore.resolve(cover.filePath))).toBe(true);
    }
  }, 60_000);
});

/** 导出联动：buildExportZip 携带选中封面时输出 00-封面.png，正文仍从 01 起 */
describe("buildExportZip with selected cover", () => {
  it("prepends 00-封面.png when a cover is provided; no change otherwise", async () => {
    const pageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const coverBuffer = Buffer.from([0x00, 0x01, 0x02]);
    const base = {
      runId: "run_covers_test",
      topic: "测试主题",
      storyboard: { title: "测试作品", platform: "xiaohongshu", aspectRatio: "3:4" },
      copy: templateCopy(
        { topic: "测试主题", platform: "xiaohongshu", aspectRatio: "3:4" } as CreateRunInput,
        [{ index: 0, role: "cover", headline: "封面页" }],
        "核心结论",
      ),
      manifest: { runId: "run_covers_test" },
      pages: [
        { index: 0, role: "cover", headline: "封面页", body: [], filename: "page-0.png", buffer: pageBuffer },
        { index: 1, role: "content", headline: "正文页", body: [], filename: "page-1.png", buffer: pageBuffer },
      ],
    };

    // 无封面：images/ 只有 01、02（JSZip 的目录条目 images/ 本身不计）
    const plain = await buildExportZip({ ...base });
    const plainNames = Object.keys((await JSZip.loadAsync(plain)).files).filter(
      (n) => n.startsWith("images/") && !n.endsWith("/"),
    );
    expect(plainNames).toHaveLength(2);
    expect(plainNames.some((n) => n.startsWith("images/00-"))).toBe(false);

    // 有封面：首张 00-封面.png，正文仍 01 起
    const withCover = await buildExportZip({
      ...base,
      cover: { assetId: "asset_x", hookTitle: "一文讲透", filename: "cover-1.png", buffer: coverBuffer },
    });
    const zip = await JSZip.loadAsync(withCover);
    const names = Object.keys(zip.files).filter((n) => n.startsWith("images/") && !n.endsWith("/"));
    expect(names).toHaveLength(3);
    expect(names[0]).toBe("images/00-封面.png");
    expect(names.some((n) => /^images\/01-/.test(n))).toBe(true);
    const coverEntry = zip.file("images/00-封面.png")!;
    expect(await coverEntry.async("nodebuffer")).toEqual(coverBuffer);

    // manifest（由调用方组装）带 cover 字段——这里验证 manifest 透传
    const manifestText = await zip.file("manifest.json")!.async("string");
    expect(JSON.parse(manifestText)).toMatchObject({ runId: "run_covers_test" });
  });
});
