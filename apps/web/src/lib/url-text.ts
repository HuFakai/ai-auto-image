/** URL 抓取的纯文本工具（可单测，不触网；DNS 解析不缓存） */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PRIVATE_HOST_PATTERNS = [/^localhost$/i, /\.local$/i];

/**
 * 校验 IP 是否为禁止访问的地址（私网/回环/链路本地/元数据网段等），IPv4 + IPv6 都覆盖。
 * 非法 IP 一律视为私有（拒绝）。
 */
export function ipIsPrivate(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4IsPrivate(ip);
  if (version === 6) return ipv6IsPrivate(ip);
  return true;
}

function ipv4IsPrivate(ip: string): boolean {
  const [a = -1, b = -1] = ip.split(".").map((octet) => Number(octet));
  if (a === 0) return true; // 0.0.0.0/8 “本网络”
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function ipv6IsPrivate(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (!groups) return true;
  // ::/128 未指定
  if (groups.every((g) => g === 0)) return true;
  // ::1/128 回环
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // ::ffff:0:0/96（或 ::ffff:0:…:v4 变体）IPv4 映射 → 校验映射出的 IPv4
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    (groups[4] === 0xffff || groups[5] === 0xffff)
  ) {
    const v4 = ipv4FromGroups(groups[6], groups[7]);
    return v4 !== null && ipv4IsPrivate(v4);
  }
  // fc00::/7 唯一本地地址（含 fd00::/8）
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;
  // fe80::/10 链路本地
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  // 2002::/16 6to4 → 内嵌 IPv4
  if (groups[0] === 0x2002) {
    const v4 = ipv4FromGroups(groups[1], groups[2]);
    return v4 !== null && ipv4IsPrivate(v4);
  }
  // 64:ff9b::/96 NAT64 → 内嵌 IPv4
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0) {
    const v4 = ipv4FromGroups(groups[6], groups[7]);
    return v4 !== null && ipv4IsPrivate(v4);
  }
  // IPv4 兼容地址 ::a.b.c.d（已废弃但仍有实现支持）
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    (groups[6] !== 0 || groups[7] !== 0)
  ) {
    const v4 = ipv4FromGroups(groups[6], groups[7]);
    return v4 !== null && ipv4IsPrivate(v4);
  }
  return false;
}

/** 由两个 16 位分组拼出 IPv4 点分串；分组非法返回 null */
function ipv4FromGroups(hi: number | undefined, lo: number | undefined): string | null {
  if (hi === undefined || lo === undefined) return null;
  if (hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** 将 IPv6 字符串展开为 8 个 16 位分组；非法或无法展开返回 null */
function expandIPv6(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const v4Tail: number[] = [];
  // 末尾 IPv4 形式（如 ::ffff:192.168.0.1 / ::192.168.0.1）
  const v4Match = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Match) {
    const octets = v4Match[1]!.split(".").map(Number);
    if (octets.some((o) => Number.isNaN(o) || o > 255)) return null;
    v4Tail.push(((octets[0]! << 8) | octets[1]!), ((octets[2]! << 8) | octets[3]!));
    s = s.slice(0, v4Match.index);
    // 去掉 hextet 与内嵌 IPv4 之间的分隔冒号（"::" 压缩标记本身保留）
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const doubleColon = s.indexOf("::");
  if (doubleColon !== -1) {
    const left = doubleColon === 0 ? [] : s.slice(0, doubleColon).split(":");
    const right = doubleColon === s.length - 2 ? [] : s.slice(doubleColon + 2).split(":");
    const raw = [...left, ...right];
    if (raw.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    const parsed = raw.map((g) => parseInt(g, 16));
    const missing = 8 - parsed.length - v4Tail.length;
    if (missing < 0) return null;
    return [...parsed.slice(0, left.length), ...Array<number>(missing).fill(0), ...parsed.slice(left.length), ...v4Tail];
  }
  const raw = s === "" ? [] : s.split(":");
  if (raw.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const parsed = raw.map((g) => parseInt(g, 16));
  if (parsed.length + v4Tail.length !== 8) return null;
  return [...parsed, ...v4Tail];
}

/** DNS 解析校验：hostname 的全部解析地址都必须是公网地址（拒绝内网解析/DNS 重绑定） */
export async function assertPublicAddress(hostname: string): Promise<void> {
  // URL.hostname 对 IPv6 字面量带方括号，解析前去掉
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("域名无法解析");
  }
  if (addresses.length === 0) throw new Error("域名无法解析");
  for (const { address } of addresses) {
    if (ipIsPrivate(address)) {
      throw new Error("不允许访问内网或本机地址");
    }
  }
}

/**
 * 校验为可抓取的公网 HTTP(S) 地址；拒绝内网/本机/凭据 URL（SSRF 防护）。
 * 含 DNS 解析校验：hostname 的每个解析地址都须为公网。异步。
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
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
  // URL.hostname 对 IPv6 字面量带方括号，去掉后再判断
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    // IP 字面量：按地址直接判断
    if (ipIsPrivate(host)) throw new Error("不允许访问内网或本机地址");
  } else {
    if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
      throw new Error("不允许访问内网或本机地址");
    }
    // DNS 解析校验：全部解析地址须为公网（紧贴实际 fetch 前的最终 URL）
    await assertPublicAddress(host);
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

const MAX_REDIRECTS = 5;

/** 抓取 URL 正文：20s 超时、2MB 上限、仅文本响应；手动跟随重定向，每跳重新做 SSRF 校验 */
export async function fetchReadable(
  url: URL,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ title: string; text: string; truncated: boolean }> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? 2_000_000;

  let current = url;
  let redirects = 0;
  for (;;) {
    // DNS 校验紧贴实际 fetch：每次发起请求前重新解析最终 URL，逐跳防护
    await assertPublicAddress(current.hostname);

    const response = await fetch(current, {
      headers: { "User-Agent": "ai-auto-image/0.1", Accept: "text/html,text/plain" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("重定向缺少 Location");
      if (redirects >= MAX_REDIRECTS) throw new Error("重定向次数过多");
      redirects += 1;
      // 新 URL 重新走完整校验（含 DNS）
      current = await assertPublicHttpUrl(new URL(location, current).toString());
      continue;
    }

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
}
