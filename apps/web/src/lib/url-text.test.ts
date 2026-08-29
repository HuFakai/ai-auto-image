import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, extractReadableText } from "./url-text";

describe("assertPublicHttpUrl", () => {
  it("accepts a public https url", () => {
    expect(assertPublicHttpUrl("https://example.com/a?b=1").hostname).toBe("example.com");
  });

  it("rejects non-http protocols, credentials and private hosts", () => {
    expect(() => assertPublicHttpUrl("ftp://example.com")).toThrow(/http\/https/);
    expect(() => assertPublicHttpUrl("https://user:pass@example.com")).toThrow(/凭据/);
    expect(() => assertPublicHttpUrl("http://localhost:3000")).toThrow(/内网或本机/);
    expect(() => assertPublicHttpUrl("http://127.0.0.1/x")).toThrow(/内网或本机/);
    expect(() => assertPublicHttpUrl("http://192.168.1.2/x")).toThrow(/内网或本机/);
    expect(() => assertPublicHttpUrl("http://10.0.0.1/x")).toThrow(/内网或本机/);
    expect(() => assertPublicHttpUrl("not a url")).toThrow(/无效/);
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
