import { describe, expect, it } from "vitest";
import { CreateRunInputSchema } from "@aai/shared-schemas";
import { createMockProvider } from "@aai/provider-mock";
import { selectWorkflowRoutes } from "./route-selection";

describe("workflow model selection", () => {
  it("binds a selected model and preserves the server price snapshot", () => {
    const mock = createMockProvider();
    const selectedText = {
      config: mock.bundle.config,
      model: "provider-text",
      text: mock.bundle.text!,
      channelModelId: "channel-model-text",
      creditsPerCall: 7,
    };
    const input = CreateRunInputSchema.parse({
      topic: "模型选择",
      modelSelection: { textModelId: "channel-model-text" },
      modelSelectionSnapshot: {
        text: {
          modelId: "channel-model-text",
          channelId: "channel-text",
          providerModelId: "provider-text",
          creditsPerCall: 5,
          capabilities: {
            textToImage: false,
            imageEditSingle: false,
            imageEditMulti: false,
            maskEdit: false,
          },
        },
      },
    });

    const selected = selectWorkflowRoutes(input, [selectedText], []);
    expect(selected.textRoutes).toHaveLength(1);
    expect(selected.textRoutes[0]).toMatchObject({
      channelModelId: "channel-model-text",
      providerModelId: "provider-text",
      model: "provider-text",
      creditsPerCall: 5,
    });
  });

  it("does not silently fall back when a requested model is unavailable", () => {
    const mock = createMockProvider();
    const input = CreateRunInputSchema.parse({
      topic: "模型不可用",
      modelSelection: { imageModelId: "missing-image-model" },
    });
    expect(() => selectWorkflowRoutes(input, [], [{
      config: mock.bundle.config,
      model: "mock-image",
      image: mock.bundle.image!,
      channelModelId: "another-image-model",
    }])).toThrow("所选图片模型当前不可用");
  });
});
