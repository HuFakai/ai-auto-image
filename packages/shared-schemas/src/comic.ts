import { z } from "zod";

/** 内容 Recipe：阶段 2 科普漫画；阶段 3 新增 7 种内容类型（复用两条管线骨架） */
export const RecipeSchema = z.enum([
  "knowledge_cards",
  "comic_story",
  "quote_cards",
  "checklist_cards",
  "comparison_cards",
  "product_showcase",
  "book_recommendations",
  "article_digest",
  "strip_comic",
]);
export type Recipe = z.infer<typeof RecipeSchema>;

/** 产品种草（product_showcase）可选输入字段：产品资料（全部可选，缺省时 prompt 分支给出合理指令） */
export const ProductInfoSchema = z.object({
  name: z.string().max(200).optional(),
  sellingPoints: z.array(z.string().max(200)).max(12).optional(),
  audience: z.string().max(400).optional(),
  priceNote: z.string().max(200).optional(),
});
export type ProductInfo = z.infer<typeof ProductInfoSchema>;

/** 图书推荐（book_recommendations）可选输入字段：书目信息（全部可选） */
export const BookInfoSchema = z.object({
  title: z.string().max(300).optional(),
  author: z.string().max(200).optional(),
});
export type BookInfo = z.infer<typeof BookInfoSchema>;

/** 角色锚点（Character Bible 精简版）：跨页一致性的唯一事实来源 */
export const CharacterAnchorSchema = z.object({
  name: z.string().min(1),
  /** 外貌锚定描述：发型/脸型/体型/显著特征，逐页原样注入 Prompt */
  appearance: z.string().min(1),
  /** 固定服装与色板描述 */
  outfit: z.string().min(1),
  /** 角色定妆图 Prompt（文生图生成参考图） */
  refImagePrompt: z.string().min(1),
  /** 禁止变化项 */
  forbiddenChanges: z.array(z.string()).default([]),
});
export type CharacterAnchor = z.infer<typeof CharacterAnchorSchema>;

/** 单页对白/旁白 */
export const ComicDialogueSchema = z.object({
  speaker: z.string().min(1),
  text: z.string().min(1).max(120),
  type: z.enum(["speech", "narration"]).default("speech"),
});
export type ComicDialogue = z.infer<typeof ComicDialogueSchema>;

/** 漫画分镜单页：场景 + 对白（气泡渲染与一致性检查的依据） */
export const ComicPageSchema = z.object({
  index: z.number().int().min(0),
  scene: z.string().min(1),
  visualPrompt: z.string().min(1),
  cast: z.array(z.string()).min(1),
  dialogues: z.array(ComicDialogueSchema).max(4).default([]),
});
export type ComicPage = z.infer<typeof ComicPageSchema>;

/** 漫画分镜（generate-comic-storyboard 节点输出）。页数下限 1：四格漫画 strip_comic 允许 1–2 页 */
export const ComicStoryboardSchema = z.object({
  title: z.string().min(1),
  cast: z.array(CharacterAnchorSchema).min(1).max(3),
  pages: z.array(ComicPageSchema).min(1).max(8),
});
export type ComicStoryboard = z.infer<typeof ComicStoryboardSchema>;
