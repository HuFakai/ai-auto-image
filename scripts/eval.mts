/**
 * 阶段 0 评测脚本（Mock Provider，零费用，可进 CI）：
 * 固定 6 类主题 × 双文字模式，度量结构化输出解析成功率与页面渲染成功率。
 * 用法：pnpm eval ；报告写入 fixtures/reports/eval.json，低于阈值时退出码 1。
 */
import fs from "node:fs";
import path from "node:path";
import { fontsPresent } from "@aai/render-engine";
import {
  createHarness,
  createRunWith,
  disposeHarness,
  startEvalRunner,
  waitUntil,
} from "@aai/workflow-engine";
import type { TextRenderingMode } from "@aai/shared-schemas";
import { loadDotEnv } from "./lib/env.js";

loadDotEnv();

interface EvalCase {
  topic: string;
  mode: TextRenderingMode;
  category: string;
}

const CASES: EvalCase[] = [
  { topic: "三分钟看懂量子纠缠", mode: "native", category: "中文知识主题" },
  { topic: "《置身事内》：为什么地方政府像公司", mode: "deterministic", category: "图书推荐" },
  { topic: "保温杯怎么选：四个关键参数", mode: "native", category: "商品（缺价格，禁止编造）" },
  { topic: "什么是复利", mode: "native", category: "概念解释" },
  { topic: "睡眠的三个常见误区", mode: "deterministic", category: "生活科普" },
  { topic: "咖啡因是如何起作用的", mode: "native", category: "机制科普" },
];

const root = path.resolve(import.meta.dirname, "..");

interface CaseResult {
  topic: string;
  category: string;
  mode: TextRenderingMode;
  runStatus: string;
  briefOk: boolean;
  storyboardOk: boolean;
  pagesExpected: number;
  pagesSucceeded: number;
  durationMs: number;
}

async function runCase(evaluationCase: EvalCase): Promise<CaseResult> {
  const harness = await createHarness();
  try {
    const runner = startEvalRunner(harness);
    const startedAt = Date.now();
    const { runId, jobId } = await createRunWith(harness, {
      topic: evaluationCase.topic,
      textRenderingMode: evaluationCase.mode,
    });

    await waitUntil(async () => {
      const status = (await harness.jobRepo.require(jobId)).status;
      return ["succeeded", "failed", "cancelled"].includes(status);
    }, 60_000);
    await runner.stop();

    const nodes = await harness.runRepo.listNodeRuns(runId);
    const briefOk = nodes.some((n) => n.nodeName === "generate-brief" && n.status === "succeeded");
    const storyboardOk = nodes.some((n) => n.nodeName === "generate-storyboard" && n.status === "succeeded");
    const imageNodes = nodes.filter((n) => n.nodeName === "generate-images");
    const pagesSucceeded = imageNodes.filter((n) => n.status === "succeeded").length;

    return {
      topic: evaluationCase.topic,
      category: evaluationCase.category,
      mode: evaluationCase.mode,
      runStatus: (await harness.runRepo.require(runId)).status,
      briefOk,
      storyboardOk,
      pagesExpected: imageNodes.length,
      pagesSucceeded,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await disposeHarness(harness);
  }
}

async function main(): Promise<void> {
  const fontsAvailable = fontsPresent();
  const cases = CASES.map((evaluationCase) =>
    // 确定性模式需要字体；缺失时降级为 native 并在报告中说明
    evaluationCase.mode === "deterministic" && !fontsAvailable
      ? { ...evaluationCase, mode: "native" as const, category: `${evaluationCase.category}（字体缺失，降级 native）` }
      : evaluationCase,
  );

  console.log(`评测开始：${cases.length} 个用例（Mock Provider，零费用）\n`);
  const results: CaseResult[] = [];
  for (const evaluationCase of cases) {
    const result = await runCase(evaluationCase);
    results.push(result);
    console.log(
      `  [${result.runStatus === "succeeded" ? "✓" : "✗"}] ${result.topic} · ${result.category} · ` +
        `${result.pagesSucceeded}/${result.pagesExpected} 页 · ${(result.durationMs / 1000).toFixed(1)}s`,
    );
  }

  const structuredAttempts = results.length * 2; // brief + storyboard
  const structuredOk = results.filter((r) => r.briefOk).length + results.filter((r) => r.storyboardOk).length;
  const pagesExpected = results.reduce((sum, r) => sum + r.pagesExpected, 0);
  const pagesSucceeded = results.reduce((sum, r) => sum + r.pagesSucceeded, 0);
  const completedRuns = results.filter((r) => r.runStatus === "succeeded").length;

  const report = {
    at: new Date().toISOString(),
    provider: "mock",
    fontsAvailable,
    cases: results,
    metrics: {
      structuredParseSuccessRate: structuredAttempts > 0 ? structuredOk / structuredAttempts : 0,
      pageRenderSuccessRate: pagesExpected > 0 ? pagesSucceeded / pagesExpected : 0,
      runCompletionRate: results.length > 0 ? completedRuns / results.length : 0,
      totalRuns: results.length,
      totalPages: pagesSucceeded,
      avgRunDurationMs: Math.round(results.reduce((sum, r) => sum + r.durationMs, 0) / results.length),
    },
    thresholds: { structuredParseSuccessRate: 0.99, pageRenderSuccessRate: 0.995, runCompletionRate: 1.0 },
  };

  const reportDir = path.join(root, "fixtures", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "eval.json"), JSON.stringify(report, null, 2));

  console.log("\n指标：");
  console.log(`  结构化输出解析成功率：${(report.metrics.structuredParseSuccessRate * 100).toFixed(1)}%（阈值 99%）`);
  console.log(`  页面渲染成功率：      ${(report.metrics.pageRenderSuccessRate * 100).toFixed(1)}%（阈值 99.5%）`);
  console.log(`  运行完成率：          ${(report.metrics.runCompletionRate * 100).toFixed(1)}%`);
  console.log(`  平均运行时长：        ${(report.metrics.avgRunDurationMs / 1000).toFixed(1)}s`);
  console.log(`\n报告：fixtures/reports/eval.json`);

  const passed =
    report.metrics.structuredParseSuccessRate >= report.thresholds.structuredParseSuccessRate &&
    report.metrics.pageRenderSuccessRate >= report.thresholds.pageRenderSuccessRate &&
    report.metrics.runCompletionRate >= report.thresholds.runCompletionRate;
  if (!passed) {
    console.error("\n✗ 评测未达阈值");
    process.exit(1);
  }
  console.log("✓ 评测通过");
}

await main();
