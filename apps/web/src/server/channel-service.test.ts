import { describe, expect, it } from "vitest";
import { ChannelInputSchema, ChannelPatchSchema } from "./channel-service";

const base = {
  name: "主力文本",
  type: "text" as const,
  baseUrl: "https://api.example.com/v1",
  apiKey: "test-key",
  textModel: "text-model",
};

describe("channel concurrency config", () => {
  it("defaults new channels to unlimited", () => {
    expect(ChannelInputSchema.parse(base).concurrencyMax).toBe(0);
  });

  it("accepts a positive channel limit", () => {
    expect(ChannelInputSchema.parse({ ...base, concurrencyMax: 32 }).concurrencyMax).toBe(32);
  });

  it("does not reset concurrency when patching another field", () => {
    expect(ChannelPatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});
