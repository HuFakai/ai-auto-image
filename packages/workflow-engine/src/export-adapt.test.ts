import { describe, expect, it } from "vitest";
import { fontsPresent } from "@aai/render-engine";
import type { CreateRunInput, Storyboard } from "@aai/shared-schemas";
import { buildPlatformAdaptation } from "./export";
import {
  createHarness,
  createRunWith,
  disposeHarness,
  startEvalRunner,
  waitUntil,
} from "./testkit";

/** 适配产物只存在于导出 ZIP，不写 assets 表；确定性重排依赖字体 */
describe.skipIf(!fontsPresent())("buildPlatformAdaptation (needs fonts)", () => {
  it("重排到 9:16 与 16:9 逐页产出合法 PNG，且不新增 assets 行", async () => {
    const harness = await createHarness({ mock: { latencyMs: 1 } });
    try {
      // 先跑完一个 deterministic 全流程 run（默认 3:4 = 小红书）
      const { runId, jobId } = await createRunWith(harness, {
        topic: "什么是复利",
        textRenderingMode: "deterministic",
      });
      const runner = startEvalRunner(harness);
      await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded", 30_000);
      await runner.stop();

      const run = await harness.runRepo.require(runId);
      const input = JSON.parse(run.inputJson) as CreateRunInput;
      const storyboardNode = (await harness.runRepo.listNodeRuns(runId)).find(
        (n) => n.nodeName === "generate-storyboard" && n.status === "succeeded",
      );
      expect(storyboardNode?.outputRef).toBeTruthy();
      const storyboard = (JSON.parse(storyboardNode!.outputRef!) as { value: Storyboard }).value;
      const assetsBefore = (await harness.assetRepo.listByRun(runId)).length;

      const deps = { assetRepo: harness.assetRepo, assetStore: harness.deps.assetStore };

      // 9:16（抖音）
      const douyin = await buildPlatformAdaptation(deps, { runId, input, storyboard, targetPlatform: "douyin" });
      expect(douyin.skipped).toBe(false);
      expect(douyin.targetAspect).toBe("9:16");
      expect(douyin.pages).toHaveLength(storyboard.slides.length);
      expect(douyin.missingPages).toEqual([]);
      for (const page of douyin.pages) {
        expect(page.buffer.readUInt32BE(0)).toBe(0x89504e47); // PNG 魔数
      }

      // 16:9（公众号）同断言
      const wechat = await buildPlatformAdaptation(deps, { runId, input, storyboard, targetPlatform: "wechat" });
      expect(wechat.skipped).toBe(false);
      expect(wechat.targetAspect).toBe("16:9");
      expect(wechat.pages).toHaveLength(storyboard.slides.length);
      expect(wechat.missingPages).toEqual([]);
      for (const page of wechat.pages) {
        expect(page.buffer.readUInt32BE(0)).toBe(0x89504e47);
      }

      // 适配产物不入库：assets 表行数未增加
      expect((await harness.assetRepo.listByRun(runId)).length).toBe(assetsBefore);

      // 原始比例（3:4 = 小红书）→ 跳过
      const same = await buildPlatformAdaptation(deps, { runId, input, storyboard, targetPlatform: "xiaohongshu" });
      expect(same.skipped).toBe(true);
      expect(same.reason).toBe("same-aspect");
      expect(same.pages).toHaveLength(0);
    } finally {
      await disposeHarness(harness);
    }
  }, 60_000);
});
