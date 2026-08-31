import type { ImageModel, TextModel, VisualQualityModel } from "./interfaces";
import { Semaphore } from "./semaphore";

/**
 * 模型渠道级并发门。0 表示不限制；正整数表示该渠道所有调用共享的并发上限。
 * 限制被绑定在模型实例上，因此整套生成、返修、重绘和附加文案都会统一生效。
 */
export type ModelConcurrencyGate = Pick<Semaphore, "run">;

export function createModelConcurrencyGate(limit: number): ModelConcurrencyGate | null {
  return limit > 0 ? new Semaphore(limit) : null;
}

export function limitTextModel(model: TextModel, gate: ModelConcurrencyGate | null): TextModel {
  if (!gate) return model;
  return {
    routeId: model.routeId,
    model: model.model,
    generateText: (request) => gate.run(() => model.generateText(request)),
    generateObject: (request) => gate.run(() => model.generateObject(request)),
    capabilities: () => model.capabilities(),
  };
}

export function limitImageModel(model: ImageModel, gate: ModelConcurrencyGate | null): ImageModel {
  if (!gate) return model;
  const limited: ImageModel = {
    routeId: model.routeId,
    model: model.model,
    generate: (request) => gate.run(() => model.generate(request)),
    capabilities: () => model.capabilities(),
  };
  if (model.edit) {
    limited.edit = (request) => gate.run(() => model.edit!(request));
  }
  return limited;
}

export function limitVisualQualityModel(
  model: VisualQualityModel | null,
  gate: ModelConcurrencyGate | null,
): VisualQualityModel | null {
  if (!model || !gate) return model;
  return {
    routeId: model.routeId,
    model: model.model,
    inspect: (request) => gate.run(() => model.inspect(request)),
  };
}
