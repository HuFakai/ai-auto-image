import { maxRouteCredits, selectImageRoutes, selectTextRoutes } from "@aai/workflow-engine";
import type { CreateRunInput } from "@aai/shared-schemas";
import type { Runtime } from "./runtime";

/**
 * 计算恢复/附加作业的保守单次价格上限。
 * 没有真实渠道时，运行时会使用 Mock 路由（兼容价格按 1 点计算）；
 * 已配置免费模型时则保留 0，不把它误判为需要余额。
 */
function routePriceOrMock(routes: Array<{ creditsPerCall?: number }>): number {
  return routes.length > 0 ? maxRouteCredits(routes) : 1;
}

function imageRoutesForRecipe(
  input: CreateRunInput,
  routes: Awaited<ReturnType<Runtime["channelService"]["assembleRoutes"]>>["imageRoutes"],
) {
  // 漫画优先使用具备图生图能力的候选；与实际工作流的选择规则一致。
  if (
    (input.recipe === "comic_story" || input.recipe === "strip_comic") &&
    routes.some((route) => route.image.capabilities().imageEditSingle)
  ) {
    return routes.filter((route) => route.image.capabilities().imageEditSingle);
  }
  return routes;
}

/** 单页重试/返修实际会调用的图片模型价格上限。 */
export async function estimateImageCallCredits(runtime: Runtime, input: CreateRunInput): Promise<number> {
  const assembled = await runtime.channelService.assembleRoutes();
  const selected = selectImageRoutes(input, assembled.imageRoutes);
  return routePriceOrMock(imageRoutesForRecipe(input, selected));
}

/** 检查点恢复可能补文本或图片节点，取两类候选的较大值作为余额预检上限。 */
export async function estimateCheckpointCredits(runtime: Runtime, input: CreateRunInput): Promise<number> {
  const assembled = await runtime.channelService.assembleRoutes();
  const text = selectTextRoutes(input, assembled.textRoutes);
  const image = imageRoutesForRecipe(input, selectImageRoutes(input, assembled.imageRoutes));
  return Math.max(routePriceOrMock(text), routePriceOrMock(image));
}
