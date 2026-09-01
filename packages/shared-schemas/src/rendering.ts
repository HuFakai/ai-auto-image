import { z } from "zod";
import { AspectRatioSchema, PlatformSchema } from "./content";
import { BrandKitConfigSchema } from "./brand-kit";
import { BookInfoSchema, ProductInfoSchema, RecipeSchema } from "./comic";

export * from "./brand-kit";
export * from "./comic";

/** 创作时可选的具体模型（仅服务端在渠道开关开启时接受） */
export const ModelSelectionSchema = z.object({
  textModelId: z.string().trim().min(1).max(200).optional(),
  imageModelId: z.string().trim().min(1).max(200).optional(),
}).optional();

const ModelSelectionSnapshotItemSchema = z.object({
  modelId: z.string().min(1).max(200),
  channelId: z.string().min(1).max(200),
  providerModelId: z.string().min(1).max(200),
  creditsPerCall: z.number().int().nonnegative().max(100_000),
  capabilities: z.object({
    textToImage: z.boolean(),
    imageEditSingle: z.boolean(),
    imageEditMulti: z.boolean(),
    maskEdit: z.boolean(),
  }),
});

/** 服务端在创建时写入的模型与价格快照，防止后续后台改价影响历史运行 */
export const ModelSelectionSnapshotSchema = z.object({
  text: ModelSelectionSnapshotItemSchema.optional(),
  image: ModelSelectionSnapshotItemSchema.optional(),
}).optional();
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export type ModelSelectionSnapshot = z.infer<typeof ModelSelectionSnapshotSchema>;

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
  /** 用户选择的文本/图片模型；未传时按渠道优先级自动路由 */
  modelSelection: ModelSelectionSchema,
  /** 创建时由服务端冻结的模型价格与能力快照，客户端不应直接提交 */
  modelSelectionSnapshot: ModelSelectionSnapshotSchema,
});
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;
