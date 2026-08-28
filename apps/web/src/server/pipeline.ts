import { and, eq } from "drizzle-orm";
import path from "node:path";
import {
  AiError,
  Semaphore,
  backoffDelay,
  sleep,
  newId,
  type ImageModel,
  type TextModel,
} from "@aai/ai-core";
import {
  ASPECT_DIMENSIONS,
  buildSlideElement,
  detectOverflow,
  persistNativeImage,
  renderSatoriToPng,
  resolveTheme,
  type ThemeId,
} from "@aai/render-engine";
import {
  ContentBriefSchema,
  StoryboardSchema,
  type BrandKit,
  type ContentBrief,
  type SlidePlan,
  type Storyboard,
  type TextRenderingMode,
} from "@aai/shared-schemas";
import { z } from "zod";
import { getDb, assetRoot } from "./db";
import { assets, brandKits, projects, providerUsages, qualityReports, workflowRuns } from "./db/schema";
import { COST_ESTIMATE } from "./config";
import { buildSlideImagePrompt, buildPanelPrompt, prompts } from "./prompts";
import { recipeOf } from "./recipes";
import { resolveEffectiveConcurrency } from "./config";
import type { NodeContext } from "@aai/workflow-engine";

// ---------------------------------------------------------------------------
// Shared state passed between pipeline nodes
// ---------------------------------------------------------------------------

export interface PipelineState {
  projectId: string;
  recipeId: string;
  mode: TextRenderingMode;
  aspectRatio: string;
  platform: string;
  inputText: string;
  inputKind: string;
  product?: unknown;
  book?: unknown;
  brandName?: string;
  styleKeywords: string[];
  negativeKeywords: string[];
  brief?: ContentBrief;
  storyboard?: Storyboard;
  concurrency: { requested: number; effective: number };
}

export function stateFromProject(projectId: string): PipelineState {
  const db = getDb();
  const p = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!p) throw new Error(`project ${projectId} not found`);
  let brand: BrandKit | undefined;
  if (p.brandKitId) {
    const row = db.select().from(brandKits).where(eq(brandKits.id, p.brandKitId)).get();
    if (row) brand = JSON.parse(row.data) as BrandKit;
  }
  return {
    projectId,
    recipeId: p.recipeId,
    mode: p.textRenderingMode as TextRenderingMode,
    aspectRatio: p.aspectRatio,
    platform: p.platform,
    inputText: p.inputText,
    inputKind: p.inputKind,
    product: p.productData ? JSON.parse(p.productData) : undefined,
    book: p.bookData ? JSON.parse(p.bookData) : undefined,
    brandName: brand?.brandName,
    styleKeywords: brand?.imageStyleKeywords ?? [],
    negativeKeywords: brand?.imageNegativeKeywords ?? [],
    concurrency: { requested: p.imageConcurrency, effective: 1 },
  };
}

function saveState(state: PipelineState): void {
  const db = getDb();
  db.update(projects)
    .set({
      brief: state.brief ? JSON.stringify(state.brief) : null,
      storyboard: state.storyboard ? JSON.stringify(state.storyboard) : null,
      selectedTitle: state.storyboard?.title ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projects.id, state.projectId))
    .run();
}

export function recordUsage(input: {
  runId: string;
  nodeId: string;
  provider: string;
  model: string;
  kind: "text" | "image" | "edit";
  promptTokens?: number;
  completionTokens?: number;
  imageCount?: number;
}): void {
  const db = getDb();
  const costCents =
    input.kind === "image" || input.kind === "edit"
      ? COST_ESTIMATE.imageCallCents * (input.imageCount ?? 1)
      : COST_ESTIMATE.textCallCents;
  db.insert(providerUsages)
    .values({
      id: newId("pu"),
      runId: input.runId,
      nodeId: input.nodeId,
      provider: input.provider,
      model: input.model,
      kind: input.kind,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      imageCount: input.imageCount ?? 0,
      costCny: costCents,
    })
    .run();
}

async function requireTextModel(): Promise<TextModel> {
  const { getTextModel } = await import("./providers");
  const model = getTextModel();
  if (!model) throw new AiError("invalid_input", "未配置文本模型，请先在设置页填写 Provider");
  return model;
}

async function requireImageModel(): Promise<ImageModel> {
  const { getImageModel } = await import("./providers");
  const model = getImageModel();
  if (!model) throw new AiError("invalid_input", "未配置图片模型，请先在设置页填写 Provider");
  return model;
}

// ---------------------------------------------------------------------------
// Node handlers
// ---------------------------------------------------------------------------

/**
 * Resolve the run's PipelineState. Normally it lives under "state" (set by
 * parse-input); after a crash-resume the executor restores succeeded-node
 * outputs under their node keys, so fall back to scanning those.
 */
export function getState(ctx: NodeContext): PipelineState {
  const direct = ctx.outputs.get("state") as PipelineState | undefined;
  if (direct) return direct;
  for (const key of [
    "parse-input",
    "generate-brief",
    "generate-storyboard",
    "generate-images",
    "render-slides",
    "quality-check",
    "generate-characters",
    "generate-scenes",
    "generate-comic-storyboard",
    "generate-panels",
  ]) {
    const candidate = ctx.outputs.get(key) as PipelineState | undefined;
    if (candidate && typeof candidate === "object" && "projectId" in candidate && "recipeId" in candidate) {
      ctx.outputs.set("state", candidate);
      return candidate;
    }
  }
  // last resort: rebuild from the project row
  const state = stateFromProject(ctx.projectId);
  ctx.outputs.set("state", state);
  return state;
}

function setState(ctx: NodeContext, state: PipelineState): void {
  ctx.outputs.set("state", state);
}

export async function handleGenerateBrief(ctx: NodeContext): Promise<PipelineState> {
  const state = getState(ctx);
  const text = await requireTextModel();
  const brief = await text.generateObject<ContentBrief>({
    prompt: prompts.brief.build({
      inputText: state.inputText,
      inputKind: state.inputKind,
      recipeId: state.recipeId,
      product: state.product,
      book: state.book,
    }),
    schema: ContentBriefSchema,
    schemaDescription:
      '{"topic":"...","audience":"...","objective":"educate|promote|convert|recommend","coreMessage":"...","evidence":[{"claim":"...","source":"...","confidence":"verified|provided|inferred"}],"tone":["..."],"callToAction":"...","prohibitedClaims":["..."]}',
    signal: ctx.signal,
  });
  state.brief = brief;
  saveState(state);
  ctx.outputs.set("state", state);
  return state;
}

export async function handleGenerateStoryboard(ctx: NodeContext): Promise<PipelineState> {
  const state = getState(ctx);
  if (!state.brief) throw new Error("brief missing before storyboard");
  const text = await requireTextModel();
  const recipe = recipeOf(state.recipeId);
  const [minSlides, maxSlides] = recipe.slideRange;

  const storyboard = await text.generateObject<Storyboard>({
    prompt: prompts.storyboard.build({
      brief: state.brief,
      recipeId: state.recipeId,
      platform: state.platform as Storyboard["platform"],
      aspectRatio: state.aspectRatio,
      slideCount: Math.min(maxSlides, Math.max(minSlides, 8)),
    }),
    schema: StoryboardSchema,
    schemaDescription:
      '{"title":"...","platform":"xiaohongshu|douyin|wechat","aspectRatio":"' +
      state.aspectRatio +
      '","slides":[{"index":0,"role":"cover|content|summary|cta","headline":"...","body":["..."],"visualIntent":"...","layoutHint":"center-title|title-bullets|split-image|full-bleed"}]}',
    signal: ctx.signal,
  });

  // enforce slide count and index integrity
  storyboard.slides = storyboard.slides
    .slice(0, maxSlides)
    .map((s, i) => ({ ...s, index: i, revision: 0 }));
  if (storyboard.slides.length < minSlides) {
    throw new AiError("upstream", `storyboard returned ${storyboard.slides.length} slides, need >= ${minSlides}`);
  }
  state.storyboard = storyboard;
  saveState(state);
  ctx.outputs.set("state", state);
  return state;
}

/**
 * generate-images — the core node. Bounded by both an API semaphore (effective
 * concurrency) and the post-process semaphore (Sharp). Rate-limit errors get
 * exponential backoff with a concurrency cooldown.
 */
export async function handleGenerateImages(ctx: NodeContext): Promise<PipelineState> {
  const state = getState(ctx);
  if (!state.storyboard) throw new Error("storyboard missing before images");
  const imageModel = await requireImageModel();
  const caps = imageModel.capabilities();
  const conc = resolveEffectiveConcurrency(state.concurrency.requested, caps.maxImagesPerRequest);
  state.concurrency.effective = conc.effective;
  ctx.log(`image concurrency requested=${conc.requested} effective=${conc.effective}`);

  const db = getDb();
  const apiGate = new Semaphore(conc.effective);
  const postGate = new Semaphore(conc.postprocessMax);
  const dims = ASPECT_DIMENSIONS[state.aspectRatio as keyof typeof ASPECT_DIMENSIONS] ?? ASPECT_DIMENSIONS["3:4"];

  const tasks = state.storyboard.slides.map(async (slide) => {
    // skip slides that already have an asset at the current revision (resume support)
    const existing = db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.projectId, state.projectId),
          eq(assets.kind, state.mode === "native" ? "native" : "generated"),
          eq(assets.slideIndex, slide.index),
          eq(assets.deleted, 0)
        )
      )
      .all()
      .filter((a) => (a.meta ? (JSON.parse(a.meta) as { revision?: number }).revision === slide.revision : slide.revision === 0));
    if (existing.length > 0) {
      slide.assetId = existing[0].id;
      return;
    }

    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await apiGate.run(async () => {
          const prompt = buildSlideImagePrompt({
            slide,
            mode: state.mode,
            aspectRatio: state.aspectRatio,
            styleKeywords: state.styleKeywords,
            negativeKeywords: state.negativeKeywords,
            brandName: state.brandName,
          });
          const result = await imageModel.generate({ prompt, n: 1, aspectRatio: state.aspectRatio as never, signal: ctx.signal });
          recordUsage({
            runId: ctx.runId,
            nodeId: ctx.nodeKey,
            provider: "grok",
            model: result.model,
            kind: "image",
            imageCount: result.usage.imageCount,
          });
          const img = result.images[0];
          const assetId = newId("asset");
          const dest = path.join(assetRoot(), state.projectId, `${assetId}.jpg`);
          const persisted = await postGate.run(() =>
            persistNativeImage(img, dest, { expectedRatio: dims.width / dims.height, signal: ctx.signal })
          );
          db.insert(assets)
            .values({
              id: assetId,
              projectId: state.projectId,
              runId: ctx.runId,
              kind: state.mode === "native" ? "native" : "generated",
              slideIndex: slide.index,
              path: dest,
              url: img.url ?? null,
              mimeType: persisted.mimeType,
              width: persisted.width,
              height: persisted.height,
              bytes: persisted.bytes,
              sha256: persisted.sha256,
              meta: JSON.stringify({ revision: slide.revision, mode: state.mode, prompt }),
            })
            .run();
          slide.assetId = assetId;
        });
        return;
      } catch (err) {
        const isRate = err instanceof AiError && err.code === "rate_limit";
        if (!isRate || attempt >= 4) throw err;
        const delay = backoffDelay(attempt, 2000) + conc.effective * 500;
        ctx.log(`rate limited, backing off ${delay}ms`, { slide: slide.index, attempt });
        await sleep(delay, ctx.signal);
      }
    }
  });

  await Promise.all(tasks);
  saveState(state);
  ctx.outputs.set("state", state);
  return state;
}

/** render-slides — deterministic mode only. Composites text over visual assets. */
export async function handleRenderSlides(ctx: NodeContext): Promise<PipelineState> {
  const state = getState(ctx);
  if (!state.storyboard) throw new Error("storyboard missing before render");
  if (state.mode === "native") return state;

  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, state.projectId)).get();
  const dims = ASPECT_DIMENSIONS[state.aspectRatio as keyof typeof ASPECT_DIMENSIONS] ?? ASPECT_DIMENSIONS["3:4"];
  const theme = resolveTheme((project?.themeId as ThemeId) ?? "minimal-knowledge", null);
  const postGate = new Semaphore(resolveEffectiveConcurrency(1).postprocessMax);

  for (const slide of state.storyboard.slides) {
    if (slide.assetId) {
      const asset = db.select().from(assets).where(eq(assets.id, slide.assetId)).get();
      if (asset?.kind === "composite") continue;
    }
    await postGate.run(async () => {
      let imageBase64: string | undefined;
      if (slide.assetId) {
        const asset = db.select().from(assets).where(eq(assets.id, slide.assetId)).get();
        if (asset) {
          const { readFile } = await import("node:fs/promises");
          const buf = await readFile(asset.path);
          // downscale for compositing to bound memory
          const sharpModule = await import("sharp");
          const shrunk = await sharpModule.default(buf).resize(dims.width).jpeg({ quality: 82 }).toBuffer();
          imageBase64 = shrunk.toString("base64");
        }
      }
      const element = buildSlideElement({
        slide,
        theme,
        brandName: state.brandName,
        watermark: state.brandName,
        width: dims.width,
        height: dims.height,
        imageBase64,
      });
      const png = await renderSatoriToPng(element, dims);
      const assetId = newId("asset");
      const dest = path.join(assetRoot(), state.projectId, `${assetId}.png`);
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, png);
      db.insert(assets)
        .values({
          id: assetId,
          projectId: state.projectId,
          runId: ctx.runId,
          kind: "composite",
          slideIndex: slide.index,
          path: dest,
          mimeType: "image/png",
          width: dims.width,
          height: dims.height,
          bytes: png.length,
          meta: JSON.stringify({ revision: slide.revision, mode: "deterministic" }),
        })
        .run();
      // relation: composite derived from visual asset
      if (slide.assetId) {
        const { assetRelations } = await import("./db/schema");
        db.insert(assetRelations)
          .values({ id: newId("ar"), assetId, relatedAssetId: slide.assetId, relation: "derived" })
          .run();
      }
      slide.assetId = assetId;
    });
  }
  saveState(state);
  ctx.outputs.set("state", state);
  return state;
}

/** quality-check — deterministic checks for both modes; native text review flag. */
export async function handleQualityCheck(ctx: NodeContext): Promise<PipelineState> {
  const state = getState(ctx);
  if (!state.storyboard) throw new Error("storyboard missing before quality check");
  const db = getDb();
  const issues: Array<{ slideIndex?: number; check: string; severity: string; message: string; autoFixable: boolean }> = [];

  const dims = ASPECT_DIMENSIONS[state.aspectRatio as keyof typeof ASPECT_DIMENSIONS] ?? ASPECT_DIMENSIONS["3:4"];
  for (const slide of state.storyboard.slides) {
    if (!slide.assetId) {
      issues.push({ slideIndex: slide.index, check: "asset-present", severity: "error", message: "页面缺少图片资产", autoFixable: false });
      continue;
    }
    const asset = db.select().from(assets).where(eq(assets.id, slide.assetId)).get();
    if (asset) {
      if (dims.width && Math.abs(asset.width / asset.height - dims.width / dims.height) / (dims.width / dims.height) > 0.05) {
        issues.push({ slideIndex: slide.index, check: "ratio", severity: "warning", message: `画布比例偏差过大 (${asset.width}x${asset.height})`, autoFixable: false });
      }
      if (asset.width < 720) {
        issues.push({ slideIndex: slide.index, check: "resolution", severity: "warning", message: `分辨率偏低 (${asset.width}px)`, autoFixable: false });
      }
    }
    if (state.mode === "deterministic") {
      const theme = resolveTheme((db.select().from(projects).where(eq(projects.id, state.projectId)).get()?.themeId as ThemeId) ?? "minimal-knowledge", null);
      const findings = detectOverflow(
        { slide, theme, width: dims.width, height: dims.height },
        { headlineSize: Math.round(dims.width * (slide.role === "cover" ? 0.082 : 0.062)), bodySize: Math.round(dims.width * 0.038) }
      );
      for (const f of findings) {
        if (f.overflow) {
          issues.push({ slideIndex: slide.index, check: "text-overflow", severity: "error", message: `文字预计溢出 (${f.estimatedHeight}/${f.availableHeight}px)`, autoFixable: false });
        }
      }
    } else {
      // native mode: exact-copy comparison needs multimodal review; flag for user review
      issues.push({
        slideIndex: slide.index,
        check: "native-text-review",
        severity: "info",
        message: "原生文字模式：请人工核对图内标题与正文是否与文案完全一致（可在编辑器逐页查看）",
        autoFixable: false,
      });
    }
  }

  const passed = !issues.some((i) => i.severity === "error");
  db.insert(qualityReports)
    .values({
      id: newId("qr"),
      runId: ctx.runId,
      projectId: state.projectId,
      mode: state.mode,
      passed: passed ? 1 : 0,
      report: JSON.stringify({ passed, issues, checkedAt: new Date().toISOString() }),
    })
    .run();
  ctx.outputs.set("state", state);
  ctx.outputs.set("qualityIssues", issues);
  return state;
}

// ---------------------------------------------------------------------------
// Single-slide regeneration (used by PATCH / regenerate endpoints)
// ---------------------------------------------------------------------------

export async function regenerateSlideAsset(projectId: string, slideIndex: number, runId: string): Promise<void> {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error("project not found");
  const storyboard = project.storyboard ? (JSON.parse(project.storyboard) as Storyboard) : null;
  if (!storyboard) throw new Error("project has no storyboard");
  const slide = storyboard.slides[slideIndex];
  if (!slide) throw new Error(`slide ${slideIndex} not found`);

  const state = stateFromProject(projectId);
  state.storyboard = storyboard;

  // soft-delete the old asset and bump revision
  if (slide.assetId) {
    db.update(assets).set({ deleted: 1 }).where(eq(assets.id, slide.assetId)).run();
    const { assetRelations } = await import("./db/schema");
    db.update(assetRelations).set({ assetId: `deleted:${slide.assetId}` }).where(eq(assetRelations.assetId, slide.assetId)).run();
  }
  slide.revision += 1;
  slide.assetId = undefined;
  db.update(projects).set({ storyboard: JSON.stringify(storyboard), updatedAt: new Date().toISOString() }).where(eq(projects.id, projectId)).run();

  if (state.mode === "native") {
    const ctxLike = {
      runId,
      projectId,
      nodeKey: "regenerate-image",
      attempt: 1,
      outputs: new Map<string, unknown>([["state", state]]),
      inputs: new Map<string, unknown>(),
      signal: new AbortController().signal,
      log: () => {},
    };
    await handleGenerateImages(ctxLike);
  }
  const renderCtx = {
    runId,
    projectId,
    nodeKey: "regenerate-render",
    attempt: 1,
    outputs: new Map<string, unknown>([["state", state]]),
    inputs: new Map<string, unknown>(),
    signal: new AbortController().signal,
    log: () => {},
  };
  await handleRenderSlides(renderCtx);
  db.update(projects)
    .set({ storyboard: JSON.stringify(state.storyboard), updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId))
    .run();
}

/** Re-render one slide without any AI call (deterministic mode copy/theme edits). */
export async function rerenderSlide(projectId: string, slideIndex: number): Promise<void> {
  const state = stateFromProject(projectId);
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  const storyboard = project?.storyboard ? (JSON.parse(project.storyboard) as Storyboard) : null;
  if (!storyboard) throw new Error("no storyboard");
  state.storyboard = storyboard;
  const ctx = {
    runId: `rerender_${Date.now()}`,
    projectId,
    nodeKey: "rerender",
    attempt: 1,
    outputs: new Map<string, unknown>([["state", state]]),
    inputs: new Map<string, unknown>(),
    signal: new AbortController().signal,
    log: () => {},
  };
  await handleRenderSlides(ctx);
  db.update(projects)
    .set({ storyboard: JSON.stringify(state.storyboard), updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId))
    .run();
}

export function estimateRunCostCents(slideCount: number, mode: TextRenderingMode): number {
  const textCalls = 2; // brief + storyboard
  const imageCalls = mode === "native" ? slideCount : slideCount;
  return textCalls * COST_ESTIMATE.textCallCents + imageCalls * COST_ESTIMATE.imageCallCents;
}

export function updateRunActualCost(runId: string): void {
  const db = getDb();
  const rows = db.select().from(providerUsages).where(eq(providerUsages.runId, runId)).all();
  const total = rows.reduce((sum, r) => sum + r.costCny, 0);
  db.update(workflowRuns).set({ actualCostCny: total }).where(eq(workflowRuns.id, runId)).run();
}
