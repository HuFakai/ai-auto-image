import type {
  CreateRunInput,
  ModelSelectionSnapshot,
} from "@aai/shared-schemas";
import type { ImageRoute, TextRoute } from "./pipeline/knowledge-cards";

/** 路由缺省价格：兼容 Mock、历史运行与尚未迁移的内存装置。 */
export function routeCreditsPerCall(route: { creditsPerCall?: number }): number {
  return Number.isInteger(route.creditsPerCall) && (route.creditsPerCall ?? 0) >= 0
    ? route.creditsPerCall!
    : 1;
}

export function maxRouteCredits(routes: Array<{ creditsPerCall?: number }>): number {
  return routes.reduce((max, route) => Math.max(max, routeCreditsPerCall(route)), 0);
}

/**
 * 将用户选择收敛为单一路由；未选择时保留完整的优先级/回退路由。
 * 单一路由仍允许该渠道自己的 maxAttempts 重试，但不会切到其它模型。
 */
export function selectWorkflowRoutes(
  input: CreateRunInput,
  textRoutes: TextRoute[],
  imageRoutes: ImageRoute[],
): { textRoutes: TextRoute[]; imageRoutes: ImageRoute[] } {
  return {
    textRoutes: selectTextRoutes(input, textRoutes),
    imageRoutes: selectImageRoutes(input, imageRoutes),
  };
}

/** 仅选择文本路由；附加能力（例如发布文案）不应被图片模型选择阻断。 */
export function selectTextRoutes(input: CreateRunInput, routes: TextRoute[]): TextRoute[] {
  return pickRoute(routes, input.modelSelection?.textModelId, "文本", input.modelSelectionSnapshot?.text);
}

/** 仅选择图片路由；返修和封面等附加能力复用同一套服务端校验。 */
export function selectImageRoutes(input: CreateRunInput, routes: ImageRoute[]): ImageRoute[] {
  return pickRoute(routes, input.modelSelection?.imageModelId, "图片", input.modelSelectionSnapshot?.image);
}

function pickRoute<T extends TextRoute | ImageRoute>(
  routes: T[],
  modelId: string | undefined,
  label: string,
  snapshot: NonNullable<ModelSelectionSnapshot>["text"],
): T[] {
  if (!modelId) return routes;
  const route = routes.find((candidate) => candidate.channelModelId === modelId);
  if (!route) throw new Error(`所选${label}模型当前不可用，请检查模型渠道配置后重试`);
  if (!snapshot || snapshot.modelId !== modelId) return [route];
  return [{
    ...route,
    // 价格以创建 Run 时的服务端快照为准；模型名也冻结，避免后台改价/改名影响运行。
    model: snapshot.providerModelId,
    providerModelId: snapshot.providerModelId,
    creditsPerCall: snapshot.creditsPerCall,
  } as T];
}
