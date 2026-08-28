import type { RecipeId, TextRenderingMode, AspectRatio, Platform } from "@aai/shared-schemas";

export interface RecipeDefinition {
  id: RecipeId;
  name: string;
  description: string;
  inputKinds: Array<"topic" | "article" | "product" | "book">;
  slideRange: [number, number];
  requiredInput: string;
  /** Extra constraints injected into brief/storyboard prompts. */
  constraints: string[];
  supportsComic: boolean;
  defaultTheme: string;
}

export const RECIPES: Record<RecipeId, RecipeDefinition> = {
  "knowledge-card": {
    id: "knowledge-card",
    name: "知识卡片",
    description: "输入主题或文章，输出封面、知识点、案例、总结和 CTA。",
    inputKinds: ["topic", "article"],
    slideRange: [6, 10],
    requiredInput: "一个主题或一篇文章",
    constraints: [
      "封面只有一个主标题和一个辅助信息区",
      "单页只表达一个核心观点",
      "正文卡片不超过 60 个中文字符的密度",
      "最后一页包含总结或行动号召",
    ],
    supportsComic: false,
    defaultTheme: "minimal-knowledge",
  },
  "article-breakdown": {
    id: "article-breakdown",
    name: "文章拆解",
    description: "输入长文或 Markdown，输出摘要、观点、证据和结论卡片。",
    inputKinds: ["article"],
    slideRange: [6, 10],
    requiredInput: "一篇长文或 Markdown 文档",
    constraints: [
      "每一页的观点必须能在原文中找到依据",
      "引用原文时保持原意，不改写数字和结论",
      "单页只表达一个核心观点",
      "最后一页输出结论卡片",
    ],
    supportsComic: false,
    defaultTheme: "magazine",
  },
  "book-recommendation": {
    id: "book-recommendation",
    name: "图书推荐",
    description: "输入书名、简介和摘录，输出推荐理由、核心观点、适合人群和行动建议。",
    inputKinds: ["book"],
    slideRange: [6, 9],
    requiredInput: "书名、简介和至少一段摘录",
    constraints: [
      "摘录必须逐字保留，不得改写",
      "每条摘录需标注章节或页码来源",
      "推荐理由必须来自用户提供的信息，不得编造书评",
      "最后一页给出适合人群和行动建议",
    ],
    supportsComic: false,
    defaultTheme: "book-paper",
  },
  "product-promo": {
    id: "product-promo",
    name: "产品宣传 / 图文带货",
    description: "输入商品卖点、参数和价格，输出封面、痛点、卖点、使用场景、参数和 CTA。",
    inputKinds: ["product"],
    slideRange: [6, 10],
    requiredInput: "商品名称、核心卖点、价格和目标人群",
    constraints: [
      "商品价格和参数必须来自用户输入，不允许模型编造",
      "不得使用绝对化用语（最、第一、国家级等）",
      "痛点页必须与卖点一一呼应",
      "最后一页包含价格和购买行动号召",
    ],
    supportsComic: false,
    defaultTheme: "high-contrast",
  },
  "science-comic": {
    id: "science-comic",
    name: "科普漫画",
    description: "输入科普主题，生成角色和场景连续的多页科普漫画。",
    inputKinds: ["topic", "article"],
    slideRange: [3, 8],
    requiredInput: "一个科普主题或资料",
    constraints: [
      "科学事实必须准确，不确定的内容不出现",
      "每格对白不超过 40 个中文字符",
      "角色和场景在页面间保持一致",
      "最后一格给出知识要点总结",
    ],
    supportsComic: true,
    defaultTheme: "morandi",
  },
};

export function recipeOf(id: string): RecipeDefinition {
  return RECIPES[id as RecipeId] ?? RECIPES["knowledge-card"];
}

export const PLATFORM_SPEC: Record<Platform, { label: string; defaultRatio: AspectRatio; titleMax: number; tagCount: [number, number] }> = {
  xiaohongshu: { label: "小红书", defaultRatio: "3:4", titleMax: 20, tagCount: [4, 8] },
  douyin: { label: "抖音图文", defaultRatio: "9:16", titleMax: 30, tagCount: [3, 5] },
  wechat: { label: "微信公众号", defaultRatio: "16:9", titleMax: 64, tagCount: [0, 0] },
};

/** What each mode means for cost & editability, shown in the wizard. */
export const MODE_NOTES: Record<TextRenderingMode, string> = {
  native: "由主力图片模型直接生成含中文的完整图片：流程短、融合度高；修改文字需重新生成该页图片（产生费用）。",
  deterministic: "AI 只生成视觉层，中文由程序精确渲染：文字可编辑、价格绝对可控；每页多一次本地合成。",
  auto_fallback: "先原生出图，文字审查失败后询问是否切换确定性渲染；可能产生额外调用。",
};
