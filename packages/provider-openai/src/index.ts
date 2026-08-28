import type { z } from "zod";
import {
  AiError,
  errorFromStatus,
  type ObjectRequest,
  type TextModel,
  type TextRequest,
  type TextResult,
} from "@aai/ai-core";

export interface OpenAiTextConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Some gateways reject response_format; when true we ask JSON in the prompt only. */
  disableJsonResponseFormat?: boolean;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function chat(cfg: OpenAiTextConfig, body: unknown, signal?: AbortSignal): Promise<ChatCompletionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw errorFromStatus(res.status, await res.text().catch(() => ""));
    }
    return (await res.json()) as ChatCompletionResponse;
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new AiError("timeout", "text generation timed out");
    }
    throw new AiError("upstream", `chat completion failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new SyntaxError("no JSON found in model output");
  const sliced = candidate.slice(start);
  // Trim trailing prose after the matching JSON block.
  const lastBrace = Math.max(sliced.lastIndexOf("}"), sliced.lastIndexOf("]"));
  return JSON.parse(sliced.slice(0, lastBrace + 1));
}

export class OpenAiTextProvider implements TextModel {
  constructor(private readonly cfg: OpenAiTextConfig) {}

  async generateText(request: TextRequest): Promise<TextResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        { role: "user", content: request.prompt },
      ],
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    };
    const json = await chat(this.cfg, body, request.signal);
    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      reasoning: choice?.message?.reasoning_content ?? undefined,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
      model: this.cfg.model,
      finishReason: choice?.finish_reason,
    };
  }

  async generateObject<T>(request: ObjectRequest<T>): Promise<T> {
    const instruction = [
      request.prompt,
      "",
      `你必须只输出一个符合以下描述的 JSON 对象，不要输出任何解释、markdown 代码块标记或额外文字：`,
      request.schemaDescription,
    ].join("\n");

    const attempt = async (messages: Array<{ role: string; content: string }>): Promise<T> => {
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(this.cfg.disableJsonResponseFormat ? {} : { response_format: { type: "json_object" } }),
      };
      const json = await chat(this.cfg, body, request.signal).catch((err) => {
        // Gateways that reject response_format get one retry without it.
        if (err instanceof AiError && err.code === "invalid_input" && !this.cfg.disableJsonResponseFormat) {
          this.cfg.disableJsonResponseFormat = true;
          delete body.response_format;
          return chat(this.cfg, body, request.signal);
        }
        throw err;
      });
      const content = json.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson(content);
      return request.schema.parse(parsed);
    };

    const messages = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      { role: "user", content: instruction },
    ];
    try {
      return await attempt(messages);
    } catch (err) {
      if (err instanceof AiError) throw err;
      // One repair call that feeds validation errors back to the model.
      const repair = await attempt([
        ...messages,
        { role: "assistant", content: err instanceof Error ? "" : "" },
        {
          role: "user",
          content: `你上一次的输出无法通过 JSON Schema 校验（错误：${err instanceof Error ? err.message.slice(0, 400) : "unknown"}）。请重新输出一个严格符合描述的 JSON 对象，仍然只输出 JSON 本身。`,
        },
      ]);
      return repair satisfies T;
    }
  }

  async *streamText(request: TextRequest): AsyncIterable<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.cfg.model,
          stream: true,
          messages: [
            ...(request.system ? [{ role: "system", content: request.system }] : []),
            { role: "user", content: request.prompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw errorFromStatus(res.status, await res.text().catch(() => ""));
      }
      const decoder = new TextDecoder();
      let buf = "";
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const parsed = JSON.parse(payload) as ChatCompletionResponse & {
              choices?: Array<{ delta?: { content?: string | null } }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // ignore malformed keep-alive lines
          }
        }
      }
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw new AiError("upstream", `stream failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}
