import type { CreateRunInput, RunStatus, TextRenderingMode } from "@aai/shared-schemas";

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
  imageConcurrencyMax: number | null;
  lastTestOk: boolean | null;
  lastTestAt: number | null;
  lastTestDetail: string | null;
}

export interface RunListItem {
  runId: string;
  topic: string;
  status: RunStatus;
  mode: TextRenderingMode;
  createdAt: number;
  pageCount: number;
}

export interface RunDetailPage {
  index: number;
  role: string;
  headline: string;
  status: "pending" | "ready" | "failed";
  assetId?: string | undefined;
  mode?: string | undefined;
  expectedCopy?: string[] | undefined;
  visualCheckPassed?: boolean | undefined;
}

export interface RunDetailPayload {
  runId: string;
  status: RunStatus;
  errorSummary: string | null;
  createdAt: number;
  input: CreateRunInput;
  concurrency: { requested: number; serverMax: number; effective: number; postprocessMax: number } | null;
  totals: { promptTokens: number; completionTokens: number; totalTokens: number; images: number; costUsd: number };
  job: { id: string; status: string; attempts: number; recoveries: number } | null;
  nodes: Array<{ nodeName: string; status: string; attempt: number }>;
  storyboardTitle: string | null;
  pages: RunDetailPage[];
}

export interface RunsListPayload {
  runs: RunListItem[];
  providerLabel: string;
  providerMode: "mock" | "partial" | "real";
  serverMaxConcurrency: number;
  defaultConcurrency: number;
}
