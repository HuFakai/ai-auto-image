import { describe, expect, it } from "vitest";
import type { ImageModel, TextModel } from "./interfaces";
import { createModelConcurrencyGate, limitImageModel, limitTextModel } from "./model-concurrency";

describe("model channel concurrency", () => {
  it("treats zero as unlimited", () => {
    expect(createModelConcurrencyGate(0)).toBeNull();
  });

  it("limits all calls bound to the same channel gate", async () => {
    let active = 0;
    let peak = 0;
    const model: TextModel = {
      routeId: "text-1",
      model: "test",
      capabilities: () => ({ structuredOutput: true, imageInput: false }),
      async generateText() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { text: "ok", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0 } };
      },
      async generateObject<T>() {
        return {} as T;
      },
    };
    const gate = createModelConcurrencyGate(2);
    const limited = limitTextModel(model, gate);

    await Promise.all(
      Array.from({ length: 6 }, () => limited.generateText({ prompt: "test" })),
    );

    expect(peak).toBe(2);
  });

  it("applies the same gate to image generation", async () => {
    let active = 0;
    let peak = 0;
    const image: ImageModel = {
      routeId: "image-1",
      model: "test-image",
      capabilities: () => ({
        textToImage: true,
        imageEditSingle: false,
        imageEditMulti: false,
        maskEdit: false,
        aspectRatios: ["1:1"],
        maxImagesPerRequest: 1,
        returns: ["base64"],
        supportsSeed: false,
        supportsTransparentBackground: false,
        persistentFiles: false,
      }),
      async generate() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [{ source: "base64", base64: "AA==", mimeType: "image/png" }];
      },
    };
    const limited = limitImageModel(image, createModelConcurrencyGate(1));

    await Promise.all(
      Array.from({ length: 4 }, () => limited.generate({ prompt: "test", aspectRatio: "1:1" })),
    );

    expect(peak).toBe(1);
  });
});
