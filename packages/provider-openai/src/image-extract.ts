import type { GeneratedImage } from "@aai/shared-schemas";

/**
 * Response Extractor：把 OpenAI Images API 的响应归一化为 GeneratedImage[]。
 * OpenAI-compatible 服务的返回字段常有差异（b64_json / url / 顶层字段 / data URL），
 * 全部在此处处理，业务层永远不读取原始响应。
 */
export function extractGeneratedImages(response: unknown): GeneratedImage[] {
  if (typeof response !== "object" || response === null) return [];
  const body = response as Record<string, unknown>;
  const results: GeneratedImage[] = [];

  const pushFromItem = (item: Record<string, unknown>) => {
    const b64 = readString(item.b64_json);
    const url = readString(item.url);
    if (b64) {
      results.push({
        source: "base64",
        base64: b64,
        mimeType: "image/png",
      });
    } else if (url) {
      results.push({
        source: "url",
        remoteUrl: url,
        mimeType: guessMimeFromUrl(url),
      });
    }
  };

  if (Array.isArray(body.data)) {
    for (const item of body.data) {
      if (typeof item === "object" && item !== null) pushFromItem(item as Record<string, unknown>);
    }
  }

  // 部分 compatible 服务把结果放在顶层 url 或 images 数组
  if (results.length === 0 && typeof body.url === "string") {
    results.push({ source: "url", remoteUrl: body.url, mimeType: guessMimeFromUrl(body.url) });
  }
  if (results.length === 0 && Array.isArray(body.images)) {
    for (const item of body.images) {
      if (typeof item === "string") {
        results.push({
          source: item.startsWith("http") ? "url" : "base64",
          remoteUrl: item.startsWith("http") ? item : undefined,
          base64: item.startsWith("http") ? undefined : item,
          mimeType: "image/png",
        });
      } else if (typeof item === "object" && item !== null) {
        pushFromItem(item as Record<string, unknown>);
      }
    }
  }

  const requestId = readString(body.id);
  if (requestId) {
    for (const result of results) result.providerRequestId = requestId;
  }
  return results;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function guessMimeFromUrl(url: string): string {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)/);
    if (match?.[1]) return match[1];
  }
  if (/\.jpe?g($|\?)/i.test(url)) return "image/jpeg";
  if (/\.webp($|\?)/i.test(url)) return "image/webp";
  return "image/png";
}
