import { z } from "zod";

/** 平台目标 */
export const PlatformSchema = z.enum(["xiaohongshu", "douyin", "wechat"]);
export type Platform = z.infer<typeof PlatformSchema>;

/** 画布比例 */
export const AspectRatioSchema = z.enum(["3:4", "9:16", "1:1", "16:9"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/** 平台比例预设（用于新任务的目标比例选择）。 */
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

/** Storyboard 单页 */
export const StoryboardSlideSchema = z.object({
  index: z.number().int().min(0),
  role: SlideRoleSchema,
  headline: z.string().min(1),
  body: z.array(z.string()),
  visualIntent: z.string(),
  layoutHint: z.string(),
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
 * 统一按数组下标归一化页码：LLM 可能输出 1-based 的 slide.index，
 * 而图片资产按归一化后的 0-based page_index 存储。
 * 所有从节点持久化值解析 Storyboard 的消费方都必须先调用本函数，防止页文错位。
 */
export function normalizeSlideIndices(storyboard: Storyboard): Storyboard {
  storyboard.slides.forEach((slide, index) => {
    slide.index = index;
  });
  return storyboard;
}

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
