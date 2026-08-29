import { z } from "zod";
import { AspectRatioSchema, PlatformSchema } from "./content";
import { BrandKitConfigSchema } from "./brand-kit";
import { RecipeSchema } from "./comic";

export * from "./brand-kit";
export * from "./comic";

/**
 * 双文字渲染模式（docs/02 §9.1）：
 * - native：默认。已确认文案写入图片 Prompt，由主力图片模型直接生成含中文的完整图片。
 * - deterministic：显式开启。图片模型生成无文字视觉层，Satori/SVG + Sharp 合成文字。
 * - auto_fallback：可选。先原生，质量检查失败后按策略转入确定性渲染。默认不开启。
 */
export const TextRenderingModeSchema = z.enum(["native", "deterministic", "auto_fallback"]);
export type TextRenderingMode = z.infer<typeof TextRenderingModeSchema>;

/** 图片生成并发配置：有效并发取各上限最小值（docs/02 §9.3） */
export const GenerationConcurrencySchema = z.object({
  /** 用户请求的并发 */
  requested: z.number().int().min(1),
  /** 服务器安全上限（环境变量 IMAGE_GENERATION_CONCURRENCY_MAX） */
  serverMax: z.number().int().min(1),
  /** Provider 路由限流上限（能力表声明） */
  providerMax: z.number().int().min(1).optional(),
  /** 最终生效并发 = min(requested, serverMax, providerMax) */
  effective: z.number().int().min(1),
  /** 本地 Sharp 后处理并发，独立于图片 API 并发 */
  postprocessMax: z.number().int().min(1),
});

/** 计算有效并发 */
export function effectiveImageConcurrency(input: {
  requested: number;
  serverMax: number;
  providerMax?: number | undefined;
}): number {
  const candidates = [input.requested, input.serverMax];
  if (input.providerMax !== undefined) {
    candidates.push(input.providerMax);
  }
  return Math.max(1, Math.min(...candidates));
}

/** Studio 发起一次生成运行的输入 */
export const CreateRunInputSchema = z.object({
  recipe: RecipeSchema.default("knowledge_cards"),
  /** 科普漫画：主角设定（外貌/服装/性格），LLM 会在此基础上生成角色锚点 */
  castDescription: z.string().max(2000).optional(),
  topic: z.string().min(1).max(4000),
  platform: PlatformSchema.default("xiaohongshu"),
  aspectRatio: AspectRatioSchema.default("3:4"),
  textRenderingMode: TextRenderingModeSchema.default("native"),
  requestedImageConcurrency: z.number().int().min(1).max(16).default(1),
  /** 粘贴的参考资料正文（URL 抓取结果或用户粘贴），驱动密度拆页 */
  sourceText: z.string().max(20000).optional(),
  sourceUrl: z.string().max(500).optional(),
  /** Brand Kit 配置快照（创建时由服务端从 brand_kits 表解析冻结） */
  brandKit: BrandKitConfigSchema.optional(),
  /** 创建时提交的 Brand Kit id（运行详情展示用） */
  brandKitId: z.string().optional(),
});
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;
