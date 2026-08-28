import { z } from "zod";

// ---------------------------------------------------------------------------
// Common enums
// ---------------------------------------------------------------------------

export const PlatformSchema = z.enum(["xiaohongshu", "douyin", "wechat"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const AspectRatioSchema = z.enum(["3:4", "9:16", "1:1", "16:9", "4:3"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const TextRenderingModeSchema = z.enum(["native", "deterministic", "auto_fallback"]);
export type TextRenderingMode = z.infer<typeof TextRenderingModeSchema>;

export const RecipeIdSchema = z.enum([
  "knowledge-card",
  "article-breakdown",
  "book-recommendation",
  "product-promo",
  "science-comic",
]);
export type RecipeId = z.infer<typeof RecipeIdSchema>;

export const ObjectiveSchema = z.enum(["educate", "promote", "convert", "recommend"]);

export const WorkflowStatusSchema = z.enum([
  "DRAFT",
  "PLANNING",
  "AWAITING_DIRECTION_APPROVAL",
  "GENERATING",
  "REVIEWING",
  "AWAITING_FINAL_APPROVAL",
  "READY_TO_EXPORT",
  "DRAFT_CREATED",
  "PUBLISHED",
  "COMPLETED",
  "PAUSED",
  "CANCELLED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const NodeStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "CANCELLED",
  "SKIPPED",
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

// ---------------------------------------------------------------------------
// Content Brief
// ---------------------------------------------------------------------------

export const ContentBriefSchema = z.object({
  topic: z.string().min(1),
  audience: z.string().min(1),
  objective: ObjectiveSchema,
  coreMessage: z.string().min(1),
  evidence: z
    .array(
      z.object({
        claim: z.string(),
        source: z.string().optional(),
        confidence: z.enum(["verified", "provided", "inferred"]),
      })
    )
    .default([]),
  tone: z.array(z.string()).default([]),
  callToAction: z.string().optional(),
  prohibitedClaims: z.array(z.string()).default([]),
});
export type ContentBrief = z.infer<typeof ContentBriefSchema>;

// ---------------------------------------------------------------------------
// Storyboard
// ---------------------------------------------------------------------------

export const SlideRoleSchema = z.enum(["cover", "content", "summary", "cta"]);

export const SlidePlanSchema = z.object({
  index: z.number().int(),
  role: SlideRoleSchema,
  headline: z.string(),
  body: z.array(z.string()).default([]),
  visualIntent: z.string(),
  layoutHint: z.string().default(""),
  /** Exact copy that must appear in the final image (native mode) or overlay (deterministic mode). */
  overlayText: z
    .object({
      badge: z.string().optional(),
      footnote: z.string().optional(),
      bullets: z.array(z.string()).optional(),
    })
    .optional(),
  assetId: z.string().optional(),
  revision: z.number().int().default(0),
});
export type SlidePlan = z.infer<typeof SlidePlanSchema>;

export const StoryboardSchema = z.object({
  title: z.string().min(1),
  platform: PlatformSchema,
  aspectRatio: AspectRatioSchema,
  slides: z.array(SlidePlanSchema).min(1).max(12),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

// ---------------------------------------------------------------------------
// Brand kit & themes
// ---------------------------------------------------------------------------

export const BrandKitSchema = z.object({
  id: z.string(),
  name: z.string(),
  brandName: z.string().optional(),
  logoAssetId: z.string().optional(),
  primaryColor: z.string().default("#1a1a1a"),
  secondaryColor: z.string().default("#6b7280"),
  backgroundColor: z.string().default("#faf7f2"),
  headingFont: z.string().default("Noto Sans SC"),
  bodyFont: z.string().default("Noto Sans SC"),
  radius: z.number().default(16),
  watermark: z.string().optional(),
  tone: z.array(z.string()).default([]),
  bannedPhrases: z.array(z.string()).default([]),
  imageStyleKeywords: z.array(z.string()).default([]),
  imageNegativeKeywords: z.array(z.string()).default([]),
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

// ---------------------------------------------------------------------------
// Concurrency (master plan 9.3)
// ---------------------------------------------------------------------------

export const GenerationConcurrencySchema = z.object({
  requested: z.number().int().min(1),
  serverMax: z.number().int().min(1),
  providerMax: z.number().int().min(1).optional(),
  effective: z.number().int().min(1),
  postprocessMax: z.number().int().min(1),
});
export type GenerationConcurrency = z.infer<typeof GenerationConcurrencySchema>;

// ---------------------------------------------------------------------------
// Phase 2: comic bibles
// ---------------------------------------------------------------------------

export const CharacterBibleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  ageRange: z.string().optional(),
  bodyType: z.string().optional(),
  faceShape: z.string().optional(),
  hair: z.string().optional(),
  distinctiveFeatures: z.array(z.string()).default([]),
  palette: z.array(z.string()).default([]),
  outfits: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
      })
    )
    .default([]),
  defaultOutfitId: z.string().optional(),
  expressions: z.array(z.string()).default([]),
  views: z.array(z.string()).default([]),
  lockedTraits: z.array(z.string()).default([]),
  referenceAssetIds: z.array(z.string()).default([]),
  canonicalPrompt: z.string().default(""),
});
export type CharacterBible = z.infer<typeof CharacterBibleSchema>;

export const SceneBibleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  timeOfDay: z.string().optional(),
  weather: z.string().optional(),
  lighting: z.string().optional(),
  spatialRelations: z.array(z.string()).default([]),
  keyProps: z.array(z.string()).default([]),
  palette: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  establishingShotAssetId: z.string().optional(),
  canonicalPrompt: z.string().default(""),
});
export type SceneBible = z.infer<typeof SceneBibleSchema>;

export const ComicPanelSchema = z.object({
  index: z.number().int(),
  shot: z.string().default("中景"),
  camera: z.string().default(""),
  characterIds: z.array(z.string()).default([]),
  outfitIds: z.record(z.string()).default({}),
  sceneId: z.string().optional(),
  action: z.string().default(""),
  expressions: z.record(z.string()).default({}),
  dialogue: z
    .array(
      z.object({
        speakerId: z.string(),
        type: z.enum(["speech", "thought", "shout", "narration", "sfx"]),
        text: z.string(),
      })
    )
    .default([]),
  continuityNotes: z.string().default(""),
  bubbleSafeZone: z.boolean().default(true),
});
export type ComicPanel = z.infer<typeof ComicPanelSchema>;

export const ComicStoryboardSchema = z.object({
  title: z.string(),
  aspectRatio: AspectRatioSchema,
  readingOrder: z.enum(["ltr", "rtl"]).default("ltr"),
  panels: z.array(ComicPanelSchema).min(1),
});
export type ComicStoryboard = z.infer<typeof ComicStoryboardSchema>;

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export const QualityIssueSchema = z.object({
  slideIndex: z.number().int().optional(),
  check: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  autoFixable: z.boolean().default(false),
});
export type QualityIssue = z.infer<typeof QualityIssueSchema>;

export const QualityReportSchema = z.object({
  runId: z.string(),
  mode: TextRenderingModeSchema,
  passed: z.boolean(),
  issues: z.array(QualityIssueSchema).default([]),
  checkedAt: z.string(),
});
export type QualityReport = z.infer<typeof QualityReportSchema>;

// ---------------------------------------------------------------------------
// Phase 3: workflow definition & platform drafts
// ---------------------------------------------------------------------------

export const WorkflowNodeKindSchema = z.enum([
  "input",
  "llm_text",
  "llm_object",
  "image_generate",
  "image_edit",
  "render",
  "quality_gate",
  "condition",
  "parallel_map",
  "human_approval",
  "transform",
  "storage",
  "export",
  "publish_draft",
  "webhook",
  "sub_workflow",
]);
export type WorkflowNodeKind = z.infer<typeof WorkflowNodeKindSchema>;

export const WorkflowNodeSchema = z.object({
  id: z.string(),
  kind: WorkflowNodeKindSchema,
  name: z.string(),
  config: z.record(z.unknown()).default({}),
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  condition: z.string().optional(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowDefinitionSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  name: z.string(),
  inputSchema: z.record(z.unknown()).default({}),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
  outputMapping: z.record(z.string()).default({}),
  limits: z
    .object({
      maxCost: z.number().optional(),
      maxDurationMs: z.number().optional(),
      maxParallelism: z.number().int().min(1).optional(),
    })
    .default({}),
  immutable: z.boolean().default(false),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const PlatformDraftInputSchema = z.object({
  platform: PlatformSchema,
  accountId: z.string(),
  projectVersion: z.string(),
  title: z.string().max(64),
  body: z.string(),
  tags: z.array(z.string()).default([]),
  imageAssetIds: z.array(z.string()).default([]),
  visibility: z.enum(["public", "private", "draft"]).default("draft"),
});
export type PlatformDraftInput = z.infer<typeof PlatformDraftInputSchema>;

export const PublishAuthorizationSchema = z.object({
  userId: z.string(),
  platform: PlatformSchema,
  accountAlias: z.string(),
  projectVersion: z.string(),
  titleSummary: z.string(),
  imageCount: z.number().int(),
  authorizedAt: z.string(),
  scope: z.enum(["draft", "publish"]),
});
export type PublishAuthorization = z.infer<typeof PublishAuthorizationSchema>;

// ---------------------------------------------------------------------------
// Phase 4: workspace / RBAC / open platform
// ---------------------------------------------------------------------------

export const RoleSchema = z.enum(["owner", "admin", "editor", "reviewer", "publisher", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const BudgetConfigSchema = z.object({
  workspaceMonthly: z.number().optional(),
  project: z.number().optional(),
  run: z.number().optional(),
  perNodeMax: z.number().optional(),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const ProviderUsageSchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  nodeId: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  kind: z.enum(["text", "image", "edit"]),
  promptTokens: z.number().int().default(0),
  completionTokens: z.number().int().default(0),
  imageCount: z.number().int().default(0),
  costCny: z.number().default(0),
  costUsd: z.number().default(0),
  createdAt: z.string(),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const WebhookEventSchema = z.enum([
  "run.completed",
  "run.failed",
  "approval.required",
  "draft.created",
  "publish.completed",
  "publish.failed",
  "budget.threshold",
]);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
