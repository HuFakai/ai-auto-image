import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAICompatProvider, type WireClient } from "./provider";

function fakeClient(overrides: Partial<WireClient> = {}): WireClient {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          id: "chatcmpl_1",
          choices: [{ message: { content: "你好" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })),
      },
    },
    images: {
      generate: vi.fn(async () => ({
        id: "imgreq_1",
        data: [{ b64_json: "QUJD" }],
        usage: { total_tokens: 100 },
      })),
    },
    ...overrides,
  };
}

const route = {
  id: "test",
  kind: "openai" as const,
  baseUrl: "https://api.example.com/v1",
  apiKeyRef: "TEST_KEY",
  textModel: "text-1",
  imageModel: "image-1",
  timeoutMs: 1000,
  maxAttempts: 1,
};

describe("createOpenAICompatProvider text model", () => {
  it("normalizes chat responses into TextResult", async () => {
    const client = fakeClient();
    const provider = createOpenAICompatProvider({ config: route, apiKey: "k", client });
    const result = await provider.text!.generateText({ prompt: "hi" });
    expect(result.text).toBe("你好");
    expect(result.usage.totalTokens).toBe(15);
    expect(result.providerRequestId).toBe("chatcmpl_1");
  });

  it("throws a retryable error on empty content", async () => {
    const client = fakeClient({
      chat: {
        completions: { create: vi.fn(async () => ({ choices: [{ message: { content: "" } }] })) },
      },
    });
    const provider = createOpenAICompatProvider({ config: route, apiKey: "k", client });
    await expect(provider.text!.generateText({ prompt: "hi" })).rejects.toThrow(/empty response/);
  });

  it("generateObject validates through the shared structured pipeline", async () => {
    const client = fakeClient({
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: '{"title":"卡","pages":2}' } }],
            usage: { total_tokens: 20 },
          })),
        },
      },
    });
    const provider = createOpenAICompatProvider({ config: route, apiKey: "k", client });
    const value = await provider.text!.generateObject({
      prompt: "生成",
      schema: z.object({ title: z.string(), pages: z.number() }),
      schemaName: "S",
    });
    expect(value).toEqual({ title: "卡", pages: 2 });
  });
});

describe("createOpenAICompatProvider image model", () => {
  it("maps aspect ratio to size and extracts images", async () => {
    const client = fakeClient();
    const provider = createOpenAICompatProvider({ config: route, apiKey: "k", client });
    const images = await provider.image!.generate({ prompt: "封面", aspectRatio: "3:4" });
    expect(images).toHaveLength(1);
    expect(images[0]?.usage?.images).toBe(1);
    const call = (client.images.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.size).toBe("1024x1536");
  });

  it("reports no edit support when the wire client lacks edit", async () => {
    const client = fakeClient();
    const provider = createOpenAICompatProvider({ config: route, apiKey: "k", client });
    await expect(
      provider.image!.edit!({ prompt: "x", aspectRatio: "1:1", baseImage: { base64: "QUJD" } }),
    ).rejects.toThrow(/does not support image edit/);
  });
});
