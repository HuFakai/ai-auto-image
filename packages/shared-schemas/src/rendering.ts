import { z } from "zod";
import { AspectRatioSchema, PlatformSchema } from "./content";
import { BrandKitConfigSchema } from "./brand-kit";
import { BookInfoSchema, ProductInfoSchema, RecipeSchema } from "./comic";

export * from "./brand-kit";
export * from "./comic";

/** Studio 发起一次生成运行的输入 */
export const CreateRunInputSchema = z.object({
  recipe: RecipeSchema.default("knowledge_cards"),
  /** 科普漫画：主角设定（外貌/服装/性格），LLM 会在此基础上生成角色锚点 */
  castDescription: z.string().max(2000).optional(),
  topic: z.string().min(1).max(4000),
  platform: PlatformSchema.default("xiaohongshu"),
  aspectRatio: AspectRatioSchema.default("3:4"),
  /** 粘贴的参考资料正文（URL 抓取结果或用户粘贴），驱动密度拆页 */
  sourceText: z.string().max(20000).optional(),
  sourceUrl: z.string().max(500).optional(),
  /** 对比卡：对比对象 B（主题为对象 A；全部可选，缺省时 prompt 分支给出合理指令） */
  comparisonTarget: z.string().max(400).optional(),
  /** 产品种草：产品资料（全部可选） */
  productInfo: ProductInfoSchema.optional(),
  /** 图书推荐：书目信息（全部可选） */
  bookInfo: BookInfoSchema.optional(),
  /** Brand Kit 配置快照（创建时由服务端从 brand_kits 表解析冻结） */
  brandKit: BrandKitConfigSchema.optional(),
  /** 创建时提交的 Brand Kit id（运行详情展示用） */
  brandKitId: z.string().optional(),
  /** 审批门：完成后进入 awaiting_approval，人工确认后才算终稿（可导出） */
  requireApproval: z.boolean().default(false),
  /** 生成 3 个封面候选（独立工序，消耗图片额度；默认关闭，可在详情页手动补生成） */
  generateCoverCandidates: z.boolean().default(false),
});
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;
