/** URL 抓取的纯文本工具（可单测，不触网） */

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /\.local$/i,
  /^\[?::1\]?$/,
];

/** 校验为可抓取的公网 HTTP(S) 地址；拒绝内网/本机/凭据 URL（SSRF 防护） */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("无效的 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅支持 http/https");
  }
  if (url.username || url.password) {
    throw new Error("不支持带凭据的 URL");
  }
  const host = url.hostname;
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new Error("不允许访问内网或本机地址");
  }
  return url;
}

/** 从 HTML 提取标题与正文纯文本 */
export function extractReadableText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities((titleMatch?.[1] ?? "").trim()).slice(0, 200);

  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // 块级标签转换为换行，保留阅读节奏
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|section|article|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");

  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 1)
    .join("\n");

  return { title, text };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** 抓取 URL 正文：20s 超时、2MB 上限、仅文本响应 */
export async function fetchReadable(
  url: URL,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ title: string; text: string; truncated: boolean }> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? 2_000_000;

  const response = await fetch(url, {
    headers: { "User-Agent": "ai-auto-image/0.1", Accept: "text/html,text/plain" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`抓取失败：HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|text\/plain/i.test(contentType)) {
    throw new Error(`不支持的内容类型：${contentType.split(";")[0] || "unknown"}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("响应无内容");
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      truncated = true;
      void reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const html = Buffer.concat(chunks).toString("utf8");
  const { title, text } = extractReadableText(html);
  if (!text) throw new Error("未能提取到正文");
  return { title, text: text.slice(0, 12000), truncated };
}
