import { describe, expect, it } from "vitest";
import { CreateRunInputSchema } from "@aai/shared-schemas";
import { createMockProvider } from "@aai/provider-mock";
import { selectImageRoutes, selectWorkflowRoutes } from "./route-selection";

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

  it("freezes automatic candidate order and price snapshots", () => {
    const mock = createMockProvider();
    const routes = [
      {
        config: { ...mock.bundle.config, id: "route-low", maxAttempts: 2 },
        model: "current-low",
        image: mock.bundle.image!,
        channelId: "channel-a",
        channelModelId: "model-low",
        providerModelId: "provider-low",
        creditsPerCall: 2,
      },
      {
        config: { ...mock.bundle.config, id: "route-high", maxAttempts: 3 },
        model: "current-high",
        image: mock.bundle.image!,
        channelId: "channel-b",
        channelModelId: "model-high",
        providerModelId: "provider-high",
        creditsPerCall: 4,
      },
    ];
    const input = CreateRunInputSchema.parse({
      topic: "自动路由快照",
      modelRouteSnapshot: {
        image: [
          {
            routeId: "route-high",
            modelId: "model-high",
            channelId: "channel-b",
            providerModelId: "provider-high-frozen",
            model: "provider-high-frozen",
            maxAttempts: 1,
            creditsPerCall: 9,
            capabilities: {
              textToImage: true,
              imageEditSingle: true,
              imageEditMulti: false,
              maskEdit: false,
            },
          },
          {
            routeId: "route-low",
            modelId: "model-low",
            channelId: "channel-a",
            providerModelId: "provider-low-frozen",
            model: "provider-low-frozen",
            maxAttempts: 2,
            creditsPerCall: 3,
            capabilities: {
              textToImage: true,
              imageEditSingle: false,
              imageEditMulti: false,
              maskEdit: false,
            },
          },
        ],
      },
    });

    const selected = selectImageRoutes(input, routes);
    expect(selected.map((route) => route.channelModelId)).toEqual(["model-high", "model-low"]);
    expect(selected.map((route) => route.creditsPerCall)).toEqual([9, 3]);
    expect(selected[0]?.config.maxAttempts).toBe(1);
    expect(selected[1]?.image.capabilities().imageEditSingle).toBe(false);
  });
});
