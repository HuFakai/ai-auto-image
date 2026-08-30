import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { fontsPresent } from "@aai/render-engine";
import {
  createHarness,
  createRunWith,
  disposeHarness,
  startEvalRunner,
  waitUntil,
  type Harness,
} from "./testkit";
import type { Storyboard } from "@aai/shared-schemas";

/* 版式路由端到端（mock 分镜：第 2 页 big-number、第 3 页 index）：
   非 default 页跳过 AI 生图（无 generated 资产）但有 composite；
   layoutData 非法的页被归一化为 default（照常生图）。 */

const harnesses: Harness[] = [];

afterAll(async () => {
  for (const harness of harnesses) await disposeHarness(harness);
});

describe.skipIf(!fontsPresent())("layout routing pipeline (mock, deterministic)", () => {
  it("skips image generation for mock-marked layout pages and composites all pages", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, {
      topic: "版式路由",
      textRenderingMode: "deterministic",
    });

    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded", 30_000);
    await runner.stop();

    const finalRun = await harness.runRepo.require(runId);
    expect(finalRun.status).toBe("succeeded");

    const assets = await harness.assetRepo.listByRun(runId);
    const generated = assets.filter((a) => a.kind === "generated");
    // mock 标注：pageIndex 1 = big-number、pageIndex 2 = index（非 default → 跳过生图）
    const generatedPages = new Set(generated.map((a) => a.pageIndex));
    expect(generatedPages.has(1)).toBe(false);
    expect(generatedPages.has(2)).toBe(false);
    // default 页照旧生图
    expect(generatedPages.has(0)).toBe(true);
    expect(generatedPages.has(3)).toBe(true);

    // 全部 4 页都有 composite（非 default 页直接纯排版）
    const composites = assets.filter((a) => a.kind === "composite");
    expect(composites).toHaveLength(4);
    const layoutComposite = composites.find((a) => a.pageIndex === 1);
    const layoutMeta = JSON.parse(layoutComposite!.metadataJson ?? "{}") as Record<string, unknown>;
    expect(layoutMeta.layout).toBe("big-number");
    const defaultComposite = composites.find((a) => a.pageIndex === 3);
    const defaultMeta = JSON.parse(defaultComposite!.metadataJson ?? "{}") as Record<string, unknown>;
    expect(defaultMeta.layout).toBe("default");

    // skipped 节点：generate-images 直接 succeed 且标记 layout-page（不调模型）
    const nodes = await harness.runRepo.listNodeRuns(runId);
    const skipped = nodes.filter(
      (n) => n.nodeName === "generate-images" && (n.outputRef ?? "").includes("layout-page"),
    );
    expect(skipped).toHaveLength(2);

    // 导出 manifest 覆盖全部 4 页并带 layout 标注（manifest 位于 exports 目录，直接读文件）
    const manifestAsset = assets.find((a) => a.kind === "export-manifest");
    expect(manifestAsset).toBeDefined();
    const manifest = JSON.parse(
      fs.readFileSync(manifestAsset!.filePath, "utf8"),
    ) as {
      pages: Array<{ pageIndex: number; layout?: string; mode?: string }>;
    };
    expect(manifest.pages).toHaveLength(4);
    expect(manifest.pages.find((p) => p.pageIndex === 1)?.layout).toBe("big-number");
    expect(manifest.pages.find((p) => p.pageIndex === 2)?.layout).toBe("index");
  });

  it("normalizes invalid layoutData back to default (page generates an image again)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    // 构造非法版式页：timeline 的 nodes 为空数组（schema 要求 3–6 个）→ 管线归一化为 default
    const storyboard = {
      title: "非法版式归一化",
      platform: "xiaohongshu" as const,
      aspectRatio: "3:4" as const,
      slides: [
        {
          index: 0,
          role: "cover" as const,
          headline: "封面",
          body: ["副标题"],
          visualIntent: "封面画面",
          layoutHint: "居中",
        },
        {
          index: 1,
          role: "content" as const,
          headline: "非法版式页",
          body: ["应回退 default 并正常生图"],
          visualIntent: "普通插画",
          layoutHint: "时间线",
          layout: "timeline",
          layoutData: { layout: "timeline", nodes: [] },
        },
        {
          index: 2,
          role: "summary" as const,
          headline: "总结",
          body: ["核心判断"],
          visualIntent: "收尾",
          layoutHint: "居中",
        },
      ],
    } as unknown as Storyboard;
    harness.mock.controls.setStoryboard(storyboard);

    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, {
      topic: "非法版式归一化",
      textRenderingMode: "deterministic",
    });

    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded", 30_000);
    await runner.stop();

    const assets = await harness.assetRepo.listByRun(runId);
    const generated = assets.filter((a) => a.kind === "generated");
    // 归一化后全部页面走 default → 每页都有 generated 资产
    expect(generated).toHaveLength(3);
    const composites = assets.filter((a) => a.kind === "composite");
    expect(composites).toHaveLength(3);
    const meta = JSON.parse(
      (composites.find((a) => a.pageIndex === 1))!.metadataJson ?? "{}",
    ) as Record<string, unknown>;
    expect(meta.layout).toBe("default");
  });
});
