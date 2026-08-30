import { z } from "zod";

/** 平台目标 */
export const PlatformSchema = z.enum(["xiaohongshu", "douyin", "wechat"]);
export type Platform = z.infer<typeof PlatformSchema>;

/** 画布比例 */
export const AspectRatioSchema = z.enum(["3:4", "9:16", "1:1", "16:9"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/**
 * 多平台一键适配预设：已完成的作品按目标平台比例确定性重排（零模型费用）。
 * xiaohongshu 是原始创作平台（不参与适配，直接用现有导出）。
 */
export const PLATFORM_PRESETS = {
  xiaohongshu: { aspectRatio: "3:4", label: "小红书" },
  douyin: { aspectRatio: "9:16", label: "抖音/视频号" },
  wechat: { aspectRatio: "16:9", label: "公众号" },
  instagram: { aspectRatio: "1:1", label: "Instagram" },
} as const satisfies Record<string, { aspectRatio: AspectRatio; label: string }>;
export type AdaptPlatform = keyof typeof PLATFORM_PRESETS;

/** 比例对应的标准画布尺寸（宽 × 高） */
export const CANVAS_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  "3:4": { width: 1242, height: 1656 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};

/** 证据项：一条内容判断及其可信度 */
export const EvidenceSchema = z.object({
  claim: z.string().min(1),
  source: z.string().optional(),
  confidence: z.enum(["verified", "provided", "inferred"]),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** 最小 Content Brief（阶段 0 Schema，见 docs/phases/00 §4.1） */
export const ContentBriefSchema = z.object({
  topic: z.string().min(1),
  audience: z.string().min(1),
  objective: z.enum(["educate", "promote", "convert", "recommend"]),
  coreMessage: z.string().min(1),
  evidence: z.array(EvidenceSchema),
  tone: z.array(z.string()),
  callToAction: z.string().optional(),
  prohibitedClaims: z.array(z.string()),
});
export type ContentBrief = z.infer<typeof ContentBriefSchema>;

/** 单页角色 */
export const SlideRoleSchema = z.enum(["cover", "content", "summary", "cta"]);
export type SlideRole = z.infer<typeof SlideRoleSchema>;

/**
 * 版式路由 hint：页面信息结构决定视觉结构（六种新页面版式 + default）。
 * default 表示沿用经典排版；其余版式为纯排版布局（不使用 AI 背景图）。
 */
export const LayoutHintSchema = z.enum([
  "default",
  "big-number",
  "timeline",
  "table",
  "index",
  "quote",
  "process",
]);
export type LayoutHint = z.infer<typeof LayoutHintSchema>;

/* ── 各版式的结构化数据（字段中英皆可，z.string() 不限语言）────────────── */

/** big-number：数据冲击页（大数字 + 说明 + 可选来源） */
export const BigNumberLayoutDataSchema = z.object({
  layout: z.literal("big-number"),
  value: z.string().min(1).max(12),
  caption: z.string().min(1).max(80),
  source: z.string().max(60).optional(),
});

/** timeline：历程/阶段页（3–6 个节点） */
export const TimelineLayoutDataSchema = z.object({
  layout: z.literal("timeline"),
  nodes: z
    .array(
      z.object({
        time: z.string().max(12).optional(),
        title: z.string().min(1).max(30),
        note: z.string().max(60).optional(),
      }),
    )
    .min(3)
    .max(6),
});

/** table：对比/参数页（2–3 列 × 2–6 行；首个列头为维度列名；每格 ≤40 字） */
export const TableLayoutDataSchema = z.object({
  layout: z.literal("table"),
  columns: z.array(z.string().min(1).max(40)).min(2).max(3),
  rows: z.array(z.array(z.string().max(40))).min(2).max(6),
}).refine(
  (data) => data.rows.every((row) => row.length === data.columns.length),
  { message: "each row must have the same number of cells as columns" },
);

/** index：目录页（2–8 个章节标题） */
export const IndexLayoutDataSchema = z.object({
  layout: z.literal("index"),
  items: z.array(z.object({ title: z.string().min(1).max(24) })).min(2).max(8),
});

/** quote：引用/金句页（引文 6–120 字 + 可选署名） */
export const QuoteLayoutDataSchema = z.object({
  layout: z.literal("quote"),
  quote: z.string().min(6).max(120),
  attribution: z.string().max(40).optional(),
});

/** process：步骤/方法页（2–6 步） */
export const ProcessLayoutDataSchema = z.object({
  layout: z.literal("process"),
  steps: z
    .array(
      z.object({
        title: z.string().min(1).max(16),
        note: z.string().max(40).optional(),
      }),
    )
    .min(2)
    .max(6),
});

/** 版式数据 discriminated union：按 layout 字面量分发校验数据形状 */
export const LayoutDataSchema = z.discriminatedUnion("layout", [
  BigNumberLayoutDataSchema,
  TimelineLayoutDataSchema,
  TableLayoutDataSchema,
  IndexLayoutDataSchema,
  QuoteLayoutDataSchema,
  ProcessLayoutDataSchema,
]);
export type LayoutData = z.infer<typeof LayoutDataSchema>;

/**
 * 解析单页版式（防御式）：hint 合法、layoutData 通过 zod 校验且与 hint 匹配才生效；
 * 否则一律回退 default（不抛错）。渲染侧与管线归一化共用这一判定。
 */
export function resolveSlideLayout(slide: Pick<StoryboardSlide, "layout" | "layoutData">): {
  layout: LayoutHint;
  layoutData?: LayoutData;
} {
  const hint = slide.layout;
  if (!hint || hint === "default" || !LayoutHintSchema.safeParse(hint).success) {
    return { layout: "default" };
  }
  const parsed = LayoutDataSchema.safeParse(slide.layoutData);
  if (!parsed.success || parsed.data.layout !== hint) {
    return { layout: "default" };
  }
  return { layout: parsed.data.layout, layoutData: parsed.data };
}

/**
 * 管线侧归一化（就地清洗）：hint 与 data 不匹配或 data 非法 → 删除 layout/layoutData
 * 字段回退 default，不抛错。旧分镜无这两个字段时原样保留。
 */
export function normalizeSlideLayout(slide: StoryboardSlide): void {
  const resolved = resolveSlideLayout(slide);
  if (resolved.layout === "default") {
    delete slide.layout;
    delete slide.layoutData;
    return;
  }
  slide.layout = resolved.layout;
  slide.layoutData = resolved.layoutData;
}

/** Storyboard 单页 */
export const StoryboardSlideSchema = z.object({
  index: z.number().int().min(0),
  role: SlideRoleSchema,
  headline: z.string().min(1),
  body: z.array(z.string()),
  visualIntent: z.string(),
  layoutHint: z.string(),
  /**
   * 版式路由 hint（宽松接受：未知值由 resolveSlideLayout/normalizeSlideLayout
   * 归一化为 default，不在 parse 时抛错，保证 LLM 输出不致整单失败）。
   */
  layout: z.string().optional(),
  /** 版式数据（形状由 LayoutDataSchema 校验；非法时管线归一化回退 default） */
  layoutData: z.unknown().optional(),
});
export type StoryboardSlide = z.infer<typeof StoryboardSlideSchema>;

/** 最小 Storyboard（阶段 0 Schema，见 docs/phases/00 §4.2） */
export const StoryboardSchema = z.object({
  title: z.string().min(1),
  platform: PlatformSchema,
  aspectRatio: AspectRatioSchema,
  slides: z.array(StoryboardSlideSchema).min(1).max(12),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

/**
 * 单页生成计划：在 Storyboard 基础上补充图片 Prompt 与预期文案。
 * 原生模式把 expectedCopy 逐字写入 Prompt；质量检查用它对比图片中的实际文字。
 */
export const SlidePlanSchema = StoryboardSlideSchema.extend({
  imagePrompt: z.string().min(1),
  /** 期望出现在图上的全部文字（含标题、正文、页码），逐字精确 */
  expectedCopy: z.array(z.string()),
});
export type SlidePlan = z.infer<typeof SlidePlanSchema>;

/** 封面候选：一个候选 = 钩子标题 + 画面描述 + 构图/风格说明 */
export const CoverCandidatePlanSchema = z.object({
  /** 封面大字标题（钩子），建议 ≤12 字 */
  hookTitle: z.string().min(2).max(20),
  /** 画面描述（给图片模型） */
  visualPrompt: z.string().min(4).max(400),
  /** 构图/风格说明（展示用） */
  styleNote: z.string().max(60),
});
export type CoverCandidatePlan = z.infer<typeof CoverCandidatePlanSchema>;

/** 封面方案：恰好 3 个候选（不同标题公式/构图） */
export const CoverPlanSchema = z.object({
  candidates: z.array(CoverCandidatePlanSchema).min(3).max(3),
});
export type CoverPlan = z.infer<typeof CoverPlanSchema>;
