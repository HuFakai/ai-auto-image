import { eq } from "drizzle-orm";
import { newId } from "@aai/ai-core";
import { InProcessJobRunner, WorkflowExecutor, type JobRecord, type NodeHandler } from "@aai/workflow-engine";
import { CharacterBibleSchema, ComicStoryboardSchema, SceneBibleSchema } from "@aai/shared-schemas";
import { z } from "zod";
import type { ContentBrief } from "@aai/shared-schemas";
import { getDb } from "./db";
import { characters, jobs, projects, scenes, workflowRuns } from "./db/schema";
import { SqliteJobPort, SqliteNodeRunPort, SqliteRunStatusPort } from "./ports";
import {
  getState,
  handleGenerateBrief,
  handleGenerateImages,
  handleGenerateStoryboard,
  handleQualityCheck,
  handleRenderSlides,
  stateFromProject,
  updateRunActualCost,
} from "./pipeline";
import { buildPanelPrompt, prompts } from "./prompts";
import { concurrencyConfig } from "./config";

// ---------------------------------------------------------------------------
// Comic (phase 2) node handlers
// ---------------------------------------------------------------------------

const CharacterListSchema = z.array(CharacterBibleSchema.omit({ id: true, projectId: true, referenceAssetIds: true }));
const SceneListSchema = z.array(SceneBibleSchema.omit({ id: true, projectId: true, establishingShotAssetId: true }));

export async function handleGenerateCharacters(ctx: Parameters<NodeHandler>[0]): Promise<unknown> {
  const state = getState(ctx);
  const text = await (await import("./providers")).getTextModel();
  if (!text) throw new Error("text model not configured");
  const list = await text.generateObject<z.infer<typeof CharacterListSchema>>({
    prompt: prompts.characterBible.build({ topic: state.inputText.slice(0, 800), characterCount: 2 }),
    schema: CharacterListSchema,
    schemaDescription: '[{"name":"...","ageRange":"...","faceShape":"...","hair":"...","distinctiveFeatures":[...],"palette":["#hex"],"outfits":[{"name":"...","description":"..."}],"canonicalPrompt":"english image prompt"}]',
    signal: ctx.signal,
  });
  const db = getDb();
  const saved = list.map((c) => {
    const id = newId("char");
    db.insert(characters).values({ id, projectId: state.projectId, name: c.name, data: JSON.stringify(c) }).run();
    return { id, ...c };
  });
  ctx.outputs.set("characters", saved);
  return saved;
}

export async function handleGenerateScenes(ctx: Parameters<NodeHandler>[0]): Promise<unknown> {
  const state = getState(ctx);
  const text = await (await import("./providers")).getTextModel();
  if (!text) throw new Error("text model not configured");
  const list = await text.generateObject<z.infer<typeof SceneListSchema>>({
    prompt: prompts.sceneBible.build({ topic: state.inputText.slice(0, 800), sceneCount: 2 }),
    schema: SceneListSchema,
    schemaDescription: '[{"name":"...","timeOfDay":"...","lighting":"...","keyProps":["..."],"palette":["#hex"],"canonicalPrompt":"english image prompt"}]',
    signal: ctx.signal,
  });
  const db = getDb();
  const saved = list.map((s) => {
    const id = newId("scene");
    db.insert(scenes).values({ id, projectId: state.projectId, name: s.name, data: JSON.stringify(s) }).run();
    return { id, ...s };
  });
  ctx.outputs.set("scenes", saved);
  return saved;
}

export async function handleGenerateComicStoryboard(ctx: Parameters<NodeHandler>[0]): Promise<unknown> {
  const state = getState(ctx);
  const text = await (await import("./providers")).getTextModel();
  if (!text) throw new Error("text model not configured");
  const characters = (ctx.outputs.get("characters") ?? []) as Array<Record<string, unknown>>;
  const scenes = (ctx.outputs.get("scenes") ?? []) as Array<Record<string, unknown>>;
  const brief = state.brief;
  const facts = brief?.evidence.map((e) => e.claim).join("；") ?? state.inputText;
  const raw = await text.generateObject<{ panels: Array<Record<string, unknown>> }>({
    prompt: prompts.comicStoryboard.build({
      topic: state.inputText.slice(0, 800),
      facts,
      characters,
      scenes,
      panelCount: 4,
    }),
    schema: ComicStoryboardSchema.omit({ title: true, aspectRatio: true, readingOrder: true }),
    schemaDescription: '{"panels":[{"shot":"中景","camera":"...","characterIds":["c1"],"outfitIds":{"c1":"o1"},"sceneId":"s1","action":"...","expressions":{"c1":"..."},"dialogue":[{"speakerId":"c1","type":"speech|thought|shout|narration|sfx","text":"..."}],"continuityNotes":"..."}]}',
    signal: ctx.signal,
  });
  const board = {
    title: brief?.topic ?? state.inputText.slice(0, 30),
    aspectRatio: state.aspectRatio,
    readingOrder: "ltr" as const,
    panels: raw.panels,
  };
  const db = getDb();
  db.update(projects)
    .set({ storyboard: JSON.stringify({ kind: "comic", ...board }), updatedAt: new Date().toISOString() })
    .where(eq(projects.id, state.projectId))
    .run();
  ctx.outputs.set("comicBoard", board);
  return board;
}

/** Panel image generation with reference-image continuity. */
export async function handleGenerateComicPanels(ctx: Parameters<NodeHandler>[0]): Promise<unknown> {
  const state = getState(ctx);
  const imageModel = await (await import("./providers")).getImageModel();
  if (!imageModel) throw new Error("image model not configured");
  const board = ctx.outputs.get("comicBoard") as
    | { title: string; panels: Array<Record<string, unknown>> }
    | undefined;
  if (!board) throw new Error("comic board missing");
  const characters = (ctx.outputs.get("characters") ?? []) as Array<{
    id: string;
    canonicalPrompt: string;
    outfits?: Array<{ name: string; description: string }>;
    defaultOutfitId?: string;
  }>;
  const scenes = (ctx.outputs.get("scenes") ?? []) as Array<{ id: string; canonicalPrompt: string }>;

  const { recordUsage } = await import("./pipeline");
  const { persistNativeImage } = await import("@aai/render-engine");
  const path = await import("node:path");
  const { assetRoot } = await import("./db");
  const { assets } = await import("./db/schema");
  const db = getDb();

  let previousSummary: string | undefined;
  const results: Array<{ panelIndex: number; assetId?: string }> = [];
  for (let i = 0; i < board.panels.length; i += 1) {
    const panel = board.panels[i] as Record<string, unknown>;
    const panelChars = (panel.characterIds as string[] ?? []).map((cid) => {
      const c = characters.find((x) => x.id === cid);
      const outfitId = (panel.outfitIds as Record<string, string> | undefined)?.[cid];
      const outfit = c?.outfits?.find((o) => o.name === outfitId);
      return { id: cid, canonicalPrompt: c?.canonicalPrompt ?? "", outfit };
    });
    const scene = scenes.find((s) => s.id === panel.sceneId);
    const dialogue = (panel.dialogue as Array<{ speakerId: string; type: string; text: string }> | undefined) ?? [];
    const dialogueText = dialogue.map((d) => `${d.speakerId}(${d.type}): ${d.text}`).join(" | ");

    const mode = state.mode;
    const prompt =
      mode === "native"
        ? [
            buildPanelPrompt({
              panel: JSON.stringify({ action: panel.action, expressions: panel.expressions }),
              index: i,
              panelCount: board.panels.length,
              characters: panelChars,
              scene,
              previousPanelSummary: previousSummary,
              aspectRatio: state.aspectRatio,
              mode,
            }),
            `Speech bubbles (Chinese, exact text, no extra words): ${dialogueText}`,
          ].join("\n")
        : buildPanelPrompt({
            panel: JSON.stringify({ action: panel.action, expressions: panel.expressions }),
            index: i,
            panelCount: board.panels.length,
            characters: panelChars,
            scene,
            previousPanelSummary: previousSummary,
            aspectRatio: state.aspectRatio,
            mode,
          });

    // continuity: attach the most recent panel image as a single reference
    const references =
      previousAssetDataUrl && imageModel.capabilities().singleReferenceEdit
        ? [{ url: previousAssetDataUrl }]
        : undefined;

    let result;
    if (references) {
      result = await imageModel.edit({ prompt, references, n: 1, aspectRatio: state.aspectRatio as never, signal: ctx.signal });
    } else {
      result = await imageModel.generate({ prompt, n: 1, aspectRatio: state.aspectRatio as never, signal: ctx.signal });
    }
    recordUsage({ runId: ctx.runId, nodeId: ctx.nodeKey, provider: "grok", model: result.model, kind: references ? "edit" : "image", imageCount: 1 });

    const assetId = newId("asset");
    const dest = path.default.join(assetRoot(), state.projectId, `${assetId}.jpg`);
    const persisted = await persistNativeImage(result.images[0], dest);
    db.insert(assets)
      .values({
        id: assetId,
        projectId: state.projectId,
        runId: ctx.runId,
        kind: "native",
        slideIndex: i,
        path: dest,
        url: result.images[0].url ?? null,
        mimeType: persisted.mimeType,
        width: persisted.width,
        height: persisted.height,
        bytes: persisted.bytes,
        sha256: persisted.sha256,
        meta: JSON.stringify({ mode, panel: i, dialogue: dialogueText }),
      })
      .run();
    results.push({ panelIndex: i, assetId });

    // build continuity summary for next panel (bounded, not full history)
    previousSummary = `${panelChars.map((c) => c.canonicalPrompt).join("; ")} | scene: ${scene?.canonicalPrompt ?? ""} | action: ${String(panel.action).slice(0, 120)}`;
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(dest);
    previousAssetDataUrl = `data:${persisted.mimeType};base64,${buf.toString("base64")}`;
    previousAssetPath = dest;
  }
  ctx.outputs.set("panelAssets", results);
  return results;
}

let previousAssetPath: string | undefined;
let previousAssetDataUrl: string | undefined;

/** Reset continuity chain between independent runs (module-level scratch state). */
export function resetComicContinuity(): void {
  previousAssetPath = undefined;
  previousAssetDataUrl = undefined;
}

// ---------------------------------------------------------------------------
// Handlers registry + run bootstrap
// ---------------------------------------------------------------------------

function buildNodeList(recipeId: string): Array<{ key: string; kind: string }> {
  if (recipeId === "science-comic") {
    return [
      { key: "parse-input", kind: "parse_input" },
      { key: "generate-brief", kind: "generate_brief" },
      { key: "generate-characters", kind: "generate_characters" },
      { key: "generate-scenes", kind: "generate_scenes" },
      { key: "generate-comic-storyboard", kind: "generate_comic_storyboard" },
      { key: "generate-panels", kind: "generate_comic_panels" },
      { key: "quality-check", kind: "quality_check" },
    ];
  }
  return [
    { key: "parse-input", kind: "parse_input" },
    { key: "generate-brief", kind: "generate_brief" },
    { key: "generate-storyboard", kind: "generate_storyboard" },
    { key: "generate-images", kind: "generate_images" },
    { key: "render-slides", kind: "render_slides" },
    { key: "quality-check", kind: "quality_check" },
  ];
}

const handlers: Record<string, NodeHandler> = {
  parse_input: async (ctx) => {
    const projectId = (ctx.inputs.get("projectId") as string) ?? ctx.projectId;
    const state = stateFromProject(projectId);
    ctx.outputs.set("state", state);
    return state;
  },
  generate_brief: handleGenerateBrief,
  generate_storyboard: handleGenerateStoryboard,
  generate_images: handleGenerateImages,
  render_slides: handleRenderSlides,
  quality_check: handleQualityCheck,
  generate_characters: handleGenerateCharacters,
  generate_scenes: handleGenerateScenes,
  generate_comic_storyboard: handleGenerateComicStoryboard,
  generate_comic_panels: handleGenerateComicPanels,
};

let runner: InProcessJobRunner | null = null;

/**
 * Idempotent lazy bootstrap. Invoked from API routes because native modules
 * (better-sqlite3) cannot be bundled into Next's instrumentation entry.
 * Uses a globalThis guard because Next bundles this module per route — a
 * module-level singleton would start one runner per route bundle.
 */
export function ensureJobRunner(): Promise<void> {
  const g = globalThis as unknown as { __aaiRunnerStarted?: Promise<void> };
  if (g.__aaiRunnerStarted) return g.__aaiRunnerStarted;
  g.__aaiRunnerStarted = (async () => {
    const cfg = concurrencyConfig();
    const jobPort = new SqliteJobPort();
    runner = new InProcessJobRunner(
      jobPort,
      async (job: JobRecord) => {
        if (job.kind === "generate_project") {
          await executeGenerationJob(job);
        } else {
          throw new Error(`unknown job kind ${job.kind}`);
        }
      },
      { concurrency: 1, pollIntervalMs: 600 }
    );
    await runner.start();
    console.info(`[runner] started (image concurrency default=${cfg.defaultRequested}, max=${cfg.serverMax})`);
  })();
  return g.__aaiRunnerStarted;
}

async function executeGenerationJob(job: JobRecord): Promise<void> {
  const payload = job.payload as { projectId: string; runId: string };
  const db = getDb();
  const executor = new WorkflowExecutor({
    nodeRuns: new SqliteNodeRunPort(),
    runStatus: new SqliteRunStatusPort(),
    handlers,
    maxAttemptsPerNode: 3,
  });
  try {
    const result = await executor.run({
      runId: payload.runId,
      projectId: payload.projectId,
      nodes: buildNodeList(stateFromProject(payload.projectId).recipeId),
      seed: {},
    });
    updateRunActualCost(payload.runId);
    if (result.status === "REVIEWING") {
      db.update(projects)
        .set({ status: "READY_TO_EXPORT", updatedAt: new Date().toISOString() })
        .where(eq(projects.id, payload.projectId))
        .run();
    } else {
      db.update(workflowRuns)
        .set({ error: result.error?.slice(0, 500) ?? null })
        .where(eq(workflowRuns.id, payload.runId))
        .run();
    }
  } catch (err) {
    db.update(workflowRuns)
      .set({
        status: "FAILED_RETRYABLE",
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      })
      .where(eq(workflowRuns.id, payload.runId))
      .run();
    throw err;
  }
}

export async function enqueueGeneration(projectId: string, runId: string): Promise<string> {
  const port = new SqliteJobPort();
  const job = await port.enqueue({
    id: newId("job"),
    kind: "generate_project",
    payload: { projectId, runId },
    runId,
    maxAttempts: 2,
  });
  // poke the runner loop if it was already started (it polls anyway)
  return job.id;
}

export function getJobStatus(jobId: string) {
  const db = getDb();
  return db.select().from(jobs).where(eq(jobs.id, jobId)).get();
}
