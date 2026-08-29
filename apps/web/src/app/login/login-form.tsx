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
    <div className="mx-auto mt-14 w-full max-w-sm rounded border border-line bg-paper p-8 shadow-[4px_4px_0_0_var(--line)]">
      <div className="mb-6 flex items-center gap-3">
        <span className="seal h-10 w-10 text-lg leading-none">印</span>
        <div>
          <h1 className="font-display text-xl font-black tracking-wide">{mode === "login" ? "登录工坊" : "注册工坊"}</h1>
          <p className="font-mono text-[9px] tracking-[0.3em] text-ink-faint">
            {mode === "login" ? "SIGN IN" : "CREATE ACCOUNT"}
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.2em] text-ink-soft">用户名</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
            className="rounded border border-line bg-white/70 px-3 py-2 font-mono text-sm outline-none focus:border-seal"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.2em] text-ink-soft">密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={8}
            className="rounded border border-line bg-white/70 px-3 py-2 font-mono text-sm outline-none focus:border-seal"
          />
        </label>
        {mode === "register" && (
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] tracking-[0.2em] text-ink-soft">邀请码（如启用）</span>
            <input
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              className="rounded border border-line bg-white/70 px-3 py-2 font-mono text-sm outline-none focus:border-seal"
            />
          </label>
        )}

        {error && <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-1 rounded bg-ink px-4 py-2.5 font-mono text-xs tracking-[0.3em] text-paper transition-opacity hover:opacity-85 disabled:opacity-50"
        >
          {busy ? "处理中…" : mode === "login" ? "登录" : "注册"}
        </button>
      </form>

      <div className="mt-6 flex items-center justify-between font-mono text-[11px] text-ink-soft">
        <button
          type="button"
          className="hover:text-seal transition-colors"
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
          className="w-full cursor-not-allowed rounded border border-line px-4 py-2 font-mono text-[11px] tracking-[0.2em] text-ink-faint"
        >
          微信扫码登录 · 即将上线
        </button>
      </div>
    </div>
  );
}
