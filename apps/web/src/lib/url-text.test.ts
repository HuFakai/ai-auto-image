import { describe, expect, it } from "vitest";
import {
  assertPublicAddress,
  assertPublicHttpUrl,
  extractReadableText,
  ipIsPrivate,
} from "./url-text";

describe("ipIsPrivate", () => {
  it("classifies private/reserved IPv4 ranges", () => {
    expect(ipIsPrivate("10.0.0.1")).toBe(true);
    expect(ipIsPrivate("172.16.0.1")).toBe(true);
    expect(ipIsPrivate("172.31.255.255")).toBe(true);
    expect(ipIsPrivate("172.32.0.1")).toBe(false);
    expect(ipIsPrivate("192.168.1.2")).toBe(true);
    expect(ipIsPrivate("127.0.0.1")).toBe(true);
    expect(ipIsPrivate("127.255.255.255")).toBe(true);
    expect(ipIsPrivate("169.254.169.254")).toBe(true); // 云元数据
    expect(ipIsPrivate("0.0.0.0")).toBe(true);
    expect(ipIsPrivate("100.64.0.1")).toBe(true); // CGNAT
    expect(ipIsPrivate("100.127.255.254")).toBe(true);
    expect(ipIsPrivate("100.128.0.1")).toBe(false);
  });

  it("classifies public IPv4 as public", () => {
    expect(ipIsPrivate("8.8.8.8")).toBe(false);
    expect(ipIsPrivate("1.1.1.1")).toBe(false);
    expect(ipIsPrivate("203.0.113.7")).toBe(false);
  });

  it("classifies private/reserved IPv6 ranges", () => {
    expect(ipIsPrivate("::1")).toBe(true); // 回环
    expect(ipIsPrivate("::")).toBe(true); // 未指定
    expect(ipIsPrivate("fc00::1")).toBe(true); // ULA
    expect(ipIsPrivate("fd12:3456::1")).toBe(true); // ULA (fd00::/8)
    expect(ipIsPrivate("fe80::1")).toBe(true); // 链路本地
    expect(ipIsPrivate("fe80:abcd::1")).toBe(true);
    expect(ipIsPrivate("::ffff:10.0.0.1")).toBe(true); // IPv4 映射私网
    expect(ipIsPrivate("::ffff:192.168.0.1")).toBe(true);
    expect(ipIsPrivate("::ffff:8.8.8.8")).toBe(false); // IPv4 映射公网
    expect(ipIsPrivate("2002:ac10:0001::")).toBe(true); // 6to4 内嵌 172.16.0.1
    expect(ipIsPrivate("64:ff9b::a00:1")).toBe(true); // NAT64 内嵌 10.0.0.1
    expect(ipIsPrivate("64:ff9b::808:808")).toBe(false); // NAT64 内嵌 8.8.8.8
  });

  it("classifies public IPv6 as public", () => {
    expect(ipIsPrivate("2606:4700:4700::1111")).toBe(false);
    expect(ipIsPrivate("2001:4860:4860::8888")).toBe(false);
  });

  it("treats non-IP garbage as private (reject)", () => {
    expect(ipIsPrivate("not-an-ip")).toBe(true);
    expect(ipIsPrivate("")).toBe(true);
  });
});

describe("assertPublicHttpUrl", () => {
  it("accepts a public url (IP literal, no DNS needed)", async () => {
    expect((await assertPublicHttpUrl("https://8.8.8.8/a?b=1")).hostname).toBe("8.8.8.8");
  });

  it("rejects non-http protocols, credentials and private hosts", async () => {
    await expect(assertPublicHttpUrl("ftp://example.com")).rejects.toThrow(/http\/https/);
    await expect(assertPublicHttpUrl("https://user:pass@example.com")).rejects.toThrow(/凭据/);
    await expect(assertPublicHttpUrl("http://localhost:3000")).rejects.toThrow(/内网或本机/);
    await expect(assertPublicHttpUrl("http://127.0.0.1/x")).rejects.toThrow(/内网或本机/);
    await expect(assertPublicHttpUrl("http://192.168.1.2/x")).rejects.toThrow(/内网或本机/);
    await expect(assertPublicHttpUrl("http://10.0.0.1/x")).rejects.toThrow(/内网或本机/);
    await expect(assertPublicHttpUrl("http://172.16.0.1/x")).rejects.toThrow(/内网或本机/);
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/内网或本机/);
    await expect(assertPublicHttpUrl("http://[::1]:3000/x")).rejects.toThrow(/内网或本机/);
    await expect(assertPublicHttpUrl("not a url")).rejects.toThrow(/无效/);
  });
});

describe("assertPublicAddress", () => {
  it("resolves localhost to private addresses and rejects", async () => {
    await expect(assertPublicAddress("localhost")).rejects.toThrow(/内网或本机/);
  });

  it("accepts a public IP literal without network resolution", async () => {
    await expect(assertPublicAddress("8.8.8.8")).resolves.toBeUndefined();
  });
});

describe("extractReadableText", () => {
  it("extracts title and body text, dropping scripts and nav", () => {
    const html = `
      <html><head><title>测试文章</title><script>var x = 1;</script></head>
      <body>
        <nav>首页 · 关于</nav>
        <article>
          <h1>标题一</h1>
          <p>第一段正文，包含重点。</p>
          <p>第二段正文。</p>
        </article>
        <footer>版权所有</footer>
      </body></html>`;
    const { title, text } = extractReadableText(html);
    expect(title).toBe("测试文章");
    expect(text).toContain("标题一");
    expect(text).toContain("第一段正文");
    expect(text).not.toContain("var x = 1");
    expect(text).not.toContain("首页");
    expect(text).not.toContain("版权所有");
  });
});
