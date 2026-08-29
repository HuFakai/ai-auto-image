import { z } from "zod";

/** 内容 Recipe：阶段 2 新增科普漫画 */
export const RecipeSchema = z.enum(["knowledge_cards", "comic_story"]);
export type Recipe = z.infer<typeof RecipeSchema>;

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

/** 漫画分镜（generate-comic-storyboard 节点输出） */
export const ComicStoryboardSchema = z.object({
  title: z.string().min(1),
  cast: z.array(CharacterAnchorSchema).min(1).max(3),
  pages: z.array(ComicPageSchema).min(3).max(8),
});
export type ComicStoryboard = z.infer<typeof ComicStoryboardSchema>;
