import type {
  CreateRunInput,
  ModelRouteSnapshotItem,
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

/** 生成可持久化的自动路由快照；Mock 路由没有渠道归属，不写入业务快照。 */
export function createModelRouteSnapshot(
  routes: Array<{
    config: { id: string; maxAttempts?: number };
    model: string;
    channelId?: string;
    channelModelId?: string;
    providerModelId?: string;
    creditsPerCall?: number;
    image?: { capabilities(): ModelRouteSnapshotItem["capabilities"] };
  }>,
): ModelRouteSnapshotItem[] {
  return routes.flatMap((route) => {
    if (!route.channelId && !route.channelModelId) return [];
    return [{
      routeId: route.config.id,
      ...(route.channelModelId ? { modelId: route.channelModelId } : {}),
      ...(route.channelId ? { channelId: route.channelId } : {}),
      providerModelId: route.providerModelId ?? route.model,
      model: route.model,
      ...(route.config.maxAttempts ? { maxAttempts: route.config.maxAttempts } : {}),
      creditsPerCall: routeCreditsPerCall(route),
      capabilities: route.image
        ? route.image.capabilities()
        : { textToImage: false, imageEditSingle: false, imageEditMulti: false, maskEdit: false },
    }];
  });
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
  const selected = pickRoute(routes, input.modelSelection?.textModelId, "文本", input.modelSelectionSnapshot?.text);
  return input.modelSelection?.textModelId
    ? selected
    : freezeAutomaticRoutes(selected, input.modelRouteSnapshot?.text, "文本");
}

/** 仅选择图片路由；返修和封面等附加能力复用同一套服务端校验。 */
export function selectImageRoutes(input: CreateRunInput, routes: ImageRoute[]): ImageRoute[] {
  const selected = pickRoute(routes, input.modelSelection?.imageModelId, "图片", input.modelSelectionSnapshot?.image);
  return input.modelSelection?.imageModelId
    ? selected
    : freezeAutomaticRoutes(selected, input.modelRouteSnapshot?.image, "图片");
}

function freezeAutomaticRoutes<T extends TextRoute | ImageRoute>(
  routes: T[],
  snapshots: ModelRouteSnapshotItem[] | undefined,
  label: string,
): T[] {
  if (!snapshots || snapshots.length === 0) return routes;
  const frozen = snapshots.flatMap((snapshot) => {
    const route = routes.find((candidate) =>
      candidate.config.id === snapshot.routeId ||
      (snapshot.modelId && candidate.channelModelId === snapshot.modelId) ||
      (snapshot.channelId && candidate.channelId === snapshot.channelId && candidate.providerModelId === snapshot.providerModelId),
    );
    if (!route) return [];
    const frozenRoute = {
      ...route,
      config: snapshot.maxAttempts
        ? { ...route.config, maxAttempts: snapshot.maxAttempts }
        : route.config,
      model: snapshot.model,
      providerModelId: snapshot.providerModelId,
      creditsPerCall: snapshot.creditsPerCall,
    } as T;
    if ("image" in frozenRoute && frozenRoute.image) {
      frozenRoute.image = {
        ...frozenRoute.image,
        // 能力快照用于恢复时的图生图过滤，避免后台改能力后改变旧任务语义。
        capabilities: () => snapshot.capabilities,
      } as typeof frozenRoute.image;
    }
    return [frozenRoute];
  });
  if (frozen.length === 0) {
    throw new Error(`运行绑定的${label}模型渠道当前不可用，请检查模型渠道后重试`);
  }
  return frozen;
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
