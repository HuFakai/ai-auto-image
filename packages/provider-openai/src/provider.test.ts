import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAICompatProvider, type WireClient } from "./provider";
import { shouldDisableReasoning } from "./routes";

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

async function* streamChunks(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
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

  it("parses streamed final content without treating reasoning as the answer", async () => {
    const create = vi.fn(async (_params: Record<string, unknown>) =>
      streamChunks(
        { id: "chat_stream_1", choices: [{ delta: { reasoning_content: "思考中" } }] },
        { choices: [{ delta: { content: [{ type: "text", text: "最终" }] } }] },
        { choices: [{ delta: { content: "答案" }, finish_reason: "stop" }], usage: { total_tokens: 9 } },
      ),
    );
    const client = fakeClient({
      chat: { completions: { create } },
    });
    const provider = createOpenAICompatProvider({ config: route, apiKey: "k", client });

    const result = await provider.text!.generateText({ prompt: "hi" });

    expect(result.text).toBe("最终答案");
    expect(result.providerRequestId).toBe("chat_stream_1");
    expect(result.usage.totalTokens).toBe(9);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ stream: true });
  });

  it("retries a reasoning-only stream with a larger non-stream budget", async () => {
    const calls: Record<string, unknown>[] = [];
    const create = vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      if (params.stream === true) {
        return streamChunks({ choices: [{ delta: { reasoning_content: "思考" }, finish_reason: "length" }] });
      }
      return {
        id: "chat_retry_1",
        choices: [{ message: { content: "最终答案" }, finish_reason: "stop" }],
        usage: { total_tokens: 20 },
      };
    });
    const client = fakeClient({
      chat: { completions: { create } },
    });
    const provider = createOpenAICompatProvider({ config: route, apiKey: "k", client });

    const result = await provider.text!.generateText({ prompt: "hi", maxOutputTokens: 1000 });

    expect(result.text).toBe("最终答案");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ stream: false, max_tokens: 4096 });
  });

  it("sends the configured DeepSeek reasoning switch in the gateway request body", async () => {
    const create = vi.fn(async (_params: Record<string, unknown>) =>
      streamChunks({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }]}),
    );
    const client = fakeClient({
      chat: { completions: { create } },
    });
    const provider = createOpenAICompatProvider({
      config: route,
      apiKey: "k",
      client,
      capabilities: {
        textRequest: {
          disableReasoning: true,
          extraParams: { reasoning_effort: "none" },
        },
      },
    });

    await expect(provider.text!.generateText({ prompt: "hi" })).resolves.toMatchObject({ text: "ok" });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      reasoning_effort: "none",
      thinking: { type: "disabled" },
    });
  });
});

describe("shouldDisableReasoning", () => {
  it("auto-disables DeepSeek reasoning but respects explicit overrides", () => {
    expect(shouldDisableReasoning("deepseek-v4-flash", {})).toBe(true);
    expect(shouldDisableReasoning("grok-4.5", {})).toBe(false);
    expect(shouldDisableReasoning("deepseek-v4-flash", { TEXT_DISABLE_REASONING: "0" })).toBe(false);
    expect(shouldDisableReasoning("grok-4.5", { TEXT_DISABLE_REASONING: "1" })).toBe(true);
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
    expect(call.size).toBe("768x1024"); // 3:4 → 1k 像素串
  });

  it("reports no edit support when the wire client lacks edit", async () => {
    const client = fakeClient();
    const provider = createOpenAICompatProvider({ config: route, apiKey: "k", client });
    await expect(
      provider.image!.edit!({ prompt: "x", aspectRatio: "1:1", baseImage: { base64: "QUJD" } }),
    ).rejects.toThrow(/does not support image edit/);
  });

  it("sends edit as multipart with a file reference (gpt-image gateway protocol)", async () => {
    const client = fakeClient();
    client.images.edit = vi.fn(async () => ({
      data: [{ b64_json: "REVG" }],
    }));
    const provider = createOpenAICompatProvider({ config: route, apiKey: "k", client });
    const images = await provider.image!.edit!({
      prompt: "把背景换成雪山",
      aspectRatio: "3:4",
      baseImage: { base64: "QUJD" },
    });
    expect(images).toHaveLength(1);
    const call = (client.images.edit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.model).toBe("image-1");
    // image 是文件对象（multipart Uploadable），size 不传沿用参考图
    expect(call.image).toBeTruthy();
    expect(call.size).toBeUndefined();
    expect(call.prompt).toBeTruthy();
  });
});
