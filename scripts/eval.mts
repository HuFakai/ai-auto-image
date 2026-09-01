/**
 * 阶段 0 评测脚本（Mock Provider，零费用，可进 CI）：
 * 固定主题用例，度量结构化输出解析成功率与页面生成成功率。
 * 用法：pnpm eval ；报告写入 fixtures/reports/eval.json，低于阈值时退出码 1。
 */
import fs from "node:fs";
import path from "node:path";
import {
  createHarness,
  createRunWith,
  disposeHarness,
  startEvalRunner,
  waitUntil,
} from "@aai/workflow-engine";
import type { CreateRunInput, Recipe } from "@aai/shared-schemas";
import { loadDotEnv } from "./lib/env.js";

loadDotEnv();

interface EvalCase {
  topic: string;
  category: string;
  recipe?: Recipe;
  productInfo?: CreateRunInput["productInfo"];
  bookInfo?: CreateRunInput["bookInfo"];
  sourceText?: string;
}

const CASES: EvalCase[] = [
  { topic: "三分钟看懂量子纠缠", category: "中文知识主题" },
  { topic: "《置身事内》：为什么地方政府像公司", category: "图书推荐" },
  { topic: "保温杯怎么选：四个关键参数", category: "商品（缺价格，禁止编造）" },
  { topic: "什么是复利", category: "概念解释" },
  { topic: "睡眠的三个常见误区", category: "生活科普" },
  { topic: "咖啡因是如何起作用的", category: "机制科普" },
  { topic: "保持专注的三句话", category: "金句卡", recipe: "quote_cards" },
  { topic: "搬家必做的五件事", category: "清单卡", recipe: "checklist_cards" },
  { topic: "骑自行车还是坐地铁通勤", category: "对比卡", recipe: "comparison_cards" },
  {
    topic: "这款便携咖啡机值得买吗",
    category: "产品种草",
    recipe: "product_showcase",
    productInfo: { name: "便携咖啡机", sellingPoints: ["小巧", "出杯快", "好清洗"] },
  },
  {
    topic: "《置身事内》为什么值得读",
    category: "图书推荐",
    recipe: "book_recommendations",
    bookInfo: { title: "置身事内", author: "兰小欢" },
  },
  {
    topic: "复利思维入门",
    category: "长文拆解",
    recipe: "article_digest",
    sourceText: "第一，复利需要时间。第二，收益率不是全部。第三，越早开始越好。",
  },
];

// 注意：strip_comic 不加入用例——Mock Provider 恒产 4 页，无法通过 strip_comic
// 的 [1,2] 页一致性检查（runComicConsistencyChecks fail 即整单失败），会拉低完成率。

const root = path.resolve(import.meta.dirname, "..");

interface CaseResult {
  topic: string;
  category: string;
  recipe: string;
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
      ...(evaluationCase.recipe ? { recipe: evaluationCase.recipe } : {}),
      ...(evaluationCase.productInfo ? { productInfo: evaluationCase.productInfo } : {}),
      ...(evaluationCase.bookInfo ? { bookInfo: evaluationCase.bookInfo } : {}),
      ...(evaluationCase.sourceText ? { sourceText: evaluationCase.sourceText } : {}),
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
      recipe: evaluationCase.recipe ?? "knowledge_cards",
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
  const cases = CASES;

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
