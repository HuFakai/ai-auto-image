import type { CreateRunInput, Recipe, RunStatus } from "@aai/shared-schemas";

/** Recipe 用户可读名（创作条类型选择与详情页共用） */
export const RECIPE_LABELS: Record<Recipe, string> = {
  knowledge_cards: "知识卡片",
  comic_story: "科普漫画",
  quote_cards: "金句卡",
  checklist_cards: "清单卡",
  comparison_cards: "对比卡",
  product_showcase: "产品种草",
  book_recommendations: "图书推荐",
  article_digest: "长文拆解",
  strip_comic: "四格漫画",
};

/** Brand Kit 视图（客户端安全） */
export interface BrandKitView {
  id: string;
  name: string;
  themeId: string;
  styleKeywords: string[];
  negativeKeywords: string[];
  logoAssetId: string | null;
  builtIn: boolean;
  brandName: string | null;
  slogan: string | null;
  footerSignature: string | null;
  watermarkText: string | null;
  watermarkPosition: string;
  watermarkOpacity: number;
  titleFont: string;
  paletteJson: { primary?: string; accent?: string; background?: string; ink?: string } | undefined;
  coverLayout: string;
}

/** 渠道模型能力（由供应商目录发现，也可由管理员修正） */
export interface ChannelModelCapabilitiesView {
  textToImage: boolean;
  imageEditSingle: boolean;
  imageEditMulti: boolean;
  maskEdit: boolean;
}

/** 渠道模型目录项（客户端安全） */
export interface ChannelModelView {
  id: string;
  channelId: string;
  type: "text" | "image";
  providerModelId: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  priority: number;
  creditsPerCall: number;
  capabilities: ChannelModelCapabilitiesView;
  discoveredAt: number;
  lastSeenAt: number;
}

/** 渠道视图（密钥已脱敏，客户端安全） */
export interface ChannelView {
  id: string;
  name: string;
  type: "text" | "image";
  baseUrl: string;
  model: string | null;
  apiKeyHint: string;
  aspectRatioParam: string;
  responseFormat: string;
  resolution: string | null;
  enabled: boolean;
  maxAttempts: number;
  /** 模型调用并发上限；0 表示不限制 */
  concurrencyMax: number;
  imageEditSupport: boolean;
  /** 渠道路由优先级；数值越大越优先 */
  priority: number;
  /** 是否允许用户在创作条自行选择该渠道模型 */
  userModelSelectionEnabled: boolean;
  modelsFetchedAt: number | null;
  models: ChannelModelView[];
  lastTestOk: boolean | null;
  lastTestAt: number | null;
  lastTestDetail: string | null;
}

/** 创作端可见的模型项：只包含选择与计费展示所需字段，不包含渠道地址或密钥 */
export interface SelectableModelView extends ChannelModelView {
  channelName: string;
}

export interface RunListItem {
  runId: string;
  topic: string;
  status: RunStatus;
  reviewStatus: "pending" | "approved" | "rejected";
  createdAt: number;
  pageCount: number;
  coverAssetId?: string | undefined;
}

export interface RunDetailPage {
  index: number;
  role: string;
  headline: string;
  status: "pending" | "ready" | "failed";
  errorSummary?: string | undefined;
  assetId?: string | undefined;
  expectedCopy?: string[] | undefined;
  visualCheckPassed?: boolean | undefined;
  /** 当前版本号（返修后 >1） */
  revision?: number | undefined;
  /** 生成该页使用的模型 */
  model?: string | undefined;
}

export interface RunDetailPayload {
  runId: string;
  status: RunStatus;
  reviewStatus: "pending" | "approved" | "rejected";
  reviewNote: string | null;
  errorSummary: string | null;
  createdAt: number;
  input: CreateRunInput;
  concurrency: { channels: Array<{ id: string; type: "text" | "image"; max: number }> } | null;
  totals: { promptTokens: number; completionTokens: number; totalTokens: number; images: number; costUsd: number };
  job: { id: string; status: string; attempts: number; recoveries: number } | null;
  nodes: Array<{ nodeName: string; status: string; attempt: number }>;
  storyboardTitle: string | null;
  /** 封面候选（kind="cover"，按 variant 排序；漫画类型为空） */
  covers: CoverCandidateView[];
  /** 用户挑选的作品封面资产 id（未挑选为 null） */
  selectedCoverAssetId: string | null;
  /** cover_generate 作业是否仍在排队/执行 */
  coverJobPending: boolean;
  /** 生成信息（来自冻结的 RunSnapshot 与输入），详情页完整呈现 */
  generation: {
    recipe: string;
    aspectRatio: string;
    platform: string;
    brandKit: { name: string; themeId: string; styleKeywords: string[] } | null;
    routes: Array<{ id: string; kind: string; model: string }>;
    characterRefAssetId: string | null;
  };
  pages: RunDetailPage[];
}

/** 封面候选（详情页展示用） */
export interface CoverCandidateView {
  assetId: string;
  variant: number;
  hookTitle: string;
  styleNote: string;
}

export interface RunsListPayload {
  runs: RunListItem[];
  providerLabel: string;
  providerMode: "mock" | "partial" | "real";
}
