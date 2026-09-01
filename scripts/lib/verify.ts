/**
 * 真实调用验证（阶段 0 手工验证项，docs/phases/00 §9）：
 * 文本 Storyboard → 原生中文出图 → 立即转存 → usage/cost 记录。
 * 用法：OPENAI_API_KEY=sk-... pnpm verify:openai（或 pnpm verify:xai）
 */
import fs from "node:fs";
import path from "node:path";
import {
  withModelFallbacks,
  type FallbackRoute,
  type ImageModel,
  type TextModel,
} from "@aai/ai-core";
import {
  CANVAS_SIZES,
  ContentBriefSchema,
  CreateRunInputSchema,
  StoryboardSchema,
  type ContentBrief,
  type CreateRunInput,
  type Storyboard,
} from "@aai/shared-schemas";
import { buildBriefPrompt, buildSlidePrompt, buildStoryboardPrompt } from "@aai/workflow-engine";
import { AssetStore } from "@aai/storage";

export function requireKey(apiKeyRef: string): string {
  const key = process.env[apiKeyRef];
  if (!key) {
    console.error(`缺少 ${apiKeyRef}。请在环境变量或仓库根目录 .env 中配置后重试。`);
    process.exit(1);
  }
  return key;
}

export interface VerifyInput {
  label: string;
  textModel: TextModel;
  imageModel: ImageModel;
  routes: FallbackRoute[];
}

export async function runVerify(input: VerifyInput): Promise<void> {
  const { label, textModel, imageModel, routes } = input;
  const verifyStartedAt = Date.now();
  const runInput: CreateRunInput = CreateRunInputSchema.parse({
    topic: "三分钟看懂量子纠缠",
    aspectRatio: "3:4",
    platform: "xiaohongshu",
  });

  /* 1. 结构化 Brief + Storyboard（与流水线相同的 Schema 校验） */
  console.log(`[1/3] 生成 Content Brief + Storyboard（${label} · ${textModel.model}）`);
  const textStartedAt = Date.now();
  const brief: ContentBrief = await textModel.generateObject({
    prompt: buildBriefPrompt(runInput),
    schemaName: "ContentBrief",
    schema: ContentBriefSchema,
  });
  const storyboard: Storyboard = await textModel.generateObject({
    prompt: buildStoryboardPrompt(runInput, brief),
    schemaName: "Storyboard",
    schema: StoryboardSchema,
  });
  console.log(
    `  「${storyboard.title}」${storyboard.slides.length} 页 · ${storyboard.platform} · ${storyboard.aspectRatio} · ${CANVAS_SIZES[storyboard.aspectRatio].width}x${CANVAS_SIZES[storyboard.aspectRatio].height}`,
  );
  const textDurationMs = Date.now() - textStartedAt;

  /* 2. 原生中文出图（封面页），经过统一路由重试 */
  const slide = storyboard.slides[0]!;
  const plan = buildSlidePrompt(slide, storyboard, runInput);
  console.log(`[2/3] 生成封面图（原生中文，预期文案 ${plan.expectedCopy.length} 条）`);
  const imageStartedAt = Date.now();
  const attempts: Array<{
    routeId: string;
    model: string;
    attempt: number;
    ok: boolean;
    statusCode?: number;
    errorCategory?: string;
    elapsedMs: number;
  }> = [];
  const result = await withModelFallbacks({
    routes,
    run: async () =>
      imageModel.generate({
        prompt: plan.imagePrompt,
        aspectRatio: runInput.aspectRatio,
        n: 1,
      }),
    onAttempt: (record) => {
      attempts.push({
        routeId: record.routeId,
        model: record.model,
        attempt: record.attempt,
        ok: record.ok,
        ...(record.statusCode === undefined ? {} : { statusCode: record.statusCode }),
        ...(record.errorCategory ? { errorCategory: record.errorCategory } : {}),
        elapsedMs: record.finishedAt - record.startedAt,
      });
      console.log(
        `  尝试 ${record.routeId}/${record.model}#${record.attempt}: ${record.ok ? "OK" : record.errorCategory} (${record.finishedAt - record.startedAt}ms)`,
      );
    },
  });
  const image = result[0]!;
  const imageDurationMs = Date.now() - imageStartedAt;

  /* 3. 立即转存到本地资产目录 + 输出报告 */
  const root = path.resolve(import.meta.dirname ?? process.cwd(), "..", "..");
  const store = new AssetStore(path.join(root, "data", "assets", "verify"));
  const saved = await store.saveGeneratedImage(image, path.join(label, "cover.png"));
  console.log(
    `[3/3] 已转存 ${path.relative(root, saved.filePath)}（${(saved.bytes / 1024).toFixed(0)} KB · ${saved.mimeType} · 耗时 ${Date.now() - startedAt}ms）`,
  );
  if (image.usage) console.log(`  usage: ${JSON.stringify(image.usage)}`);

  const reportDir = path.join(root, "fixtures", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, `${label}.json`),
    JSON.stringify(
      {
        provider: label,
        textModel: textModel.model,
        imageModel: imageModel.model,
        storyboardTitle: storyboard.title,
        slides: storyboard.slides.length,
        expectedCopy: plan.expectedCopy,
        durations: {
          textMs: textDurationMs,
          imageMs: imageDurationMs,
          totalMs: Date.now() - verifyStartedAt,
        },
        attempts,
        asset: {
          path: path.relative(root, saved.filePath),
          bytes: saved.bytes,
          mimeType: saved.mimeType,
        },
        usage: image.usage ?? null,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`  报告: fixtures/reports/${label}.json`);
}
