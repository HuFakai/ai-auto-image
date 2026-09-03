"use client";

import { useState } from "react";

type Mode = "login" | "register";

export default function LoginForm({ registerEnabled }: { registerEnabled: boolean }) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "login" ? { username, password } : { username, password, inviteCode: inviteCode || undefined },
        ),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "操作失败");
        return;
      }
      window.location.href = "/";
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rise mx-auto w-full max-w-sm rounded-[14px] border border-line bg-paper-deep p-8 shadow-[0_18px_50px_rgba(0,0,0,0.55)]">
      <div className="mb-7 flex items-center gap-3">
        <img src="/brand/logo/logo-mark.svg" alt="图叙" className="h-10 w-10 shrink-0" />
        <div>
          <h1 className="font-display text-xl font-black tracking-wide">{mode === "login" ? "登录图叙" : "注册图叙"}</h1>
          <p className="kicker mt-0.5">{mode === "login" ? "SIGN IN" : "CREATE ACCOUNT"}</p>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-5">
        <label className="flex flex-col gap-1">
          <span className="field-label">用户名</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
            className="field-input font-mono !text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="field-label">密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={8}
            className="field-input font-mono !text-sm"
          />
        </label>
        {mode === "register" && (
          <label className="flex flex-col gap-1">
            <span className="field-label">邀请码（如启用）</span>
            <input
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              className="field-input font-mono !text-sm"
            />
          </label>
        )}

        {error && (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="btn-ink mt-1 px-4 py-2.5 font-mono text-xs tracking-[0.3em]"
        >
          {busy ? "处理中…" : mode === "login" ? "登录" : "注册"}
        </button>
      </form>

      <div className="mt-6 flex items-center justify-between font-mono text-[11px] text-ink-soft">
        <button
          type="button"
          className="transition-colors hover:text-seal"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "没有账号？注册 →" : "已有账号？登录 →"}
        </button>
        {mode === "register" && !registerEnabled && <span className="text-ink-faint">当前仅限受邀</span>}
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <button
          type="button"
          disabled
          title="即将支持：微信小程序扫码登录"
          className="btn-ghost w-full cursor-not-allowed px-4 py-2 font-mono text-[11px] tracking-[0.2em] !text-ink-faint"
        >
          微信扫码登录 · 即将上线
        </button>
      </div>
    </div>
  );
}
