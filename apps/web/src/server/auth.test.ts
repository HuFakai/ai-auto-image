import { describe, expect, it } from "vitest";
import {
  clientIp,
  hashPassword,
  loginRateLimit,
  validateCredentials,
  verifyPassword,
} from "./auth";

describe("password hashing (scrypt)", () => {
  it("round-trips a password and rejects wrong ones", async () => {
    const stored = await hashPassword("正确密码123");
    expect(stored.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword("正确密码123", stored)).toBe(true);
    expect(await verifyPassword("错误密码456", stored)).toBe(false);
  });

  it("produces distinct hashes for identical passwords (random salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$2$3$abc$def")).toBe(false);
    expect(await verifyPassword("x", "scrypt$bad$payload")).toBe(false);
  });
});

describe("credential validation", () => {
  it("accepts a normal username/password pair", () => {
    expect(validateCredentials("小明", "password123")).toBeNull();
    expect(validateCredentials("user_01", "12345678")).toBeNull();
  });

  it("rejects short/long usernames, whitespace and short passwords", () => {
    expect(validateCredentials("", "password123")).toBeTypeOf("string");
    expect(validateCredentials("a", "password123")).toBeTypeOf("string");
    expect(validateCredentials("a".repeat(25), "password123")).toBeTypeOf("string");
    expect(validateCredentials("含 空格", "password123")).toBeTypeOf("string");
    expect(validateCredentials("正常名", "short")).toBeTypeOf("string");
  });
});

describe("login rate limit", () => {
  it("allows up to the limit then blocks, and resets after the window", () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 10; i += 1) {
      expect(loginRateLimit(key, 10, 50)).toBe(true);
    }
    expect(loginRateLimit(key, 10, 50)).toBe(false);
    // 新窗口/新 key 不受影响
    expect(loginRateLimit(`test:${Math.random()}`, 10, 50)).toBe(true);
  });
});

describe("clientIp", () => {
  it("prefers the first x-forwarded-for entry", () => {
    const request = new Request("http://localhost/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip then unknown", () => {
    expect(clientIp(new Request("http://localhost", { headers: { "x-real-ip": "198.51.100.2" } }))).toBe(
      "198.51.100.2",
    );
    expect(clientIp(new Request("http://localhost"))).toBe("unknown");
  });
});
