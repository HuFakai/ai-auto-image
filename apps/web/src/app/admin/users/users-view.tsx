"use client";

import { useCallback, useEffect, useState } from "react";

interface AdminUserItem {
  id: string;
  username: string;
  role: string;
  status: string;
  authProvider: string;
  createdAt: number;
  balance: number;
  totalGranted: number;
  totalConsumed: number;
  subscription: { planName: string; expiresAt: number } | null;
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("zh-CN");

export function UsersView() {
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<AdminUserItem | null>(null);
  const [delta, setDelta] = useState("10");
  const [note, setNote] = useState("");

  const reload = useCallback(async (query = "") => {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/users${query ? `?q=${encodeURIComponent(query)}` : ""}`, { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { users: AdminUserItem[] };
        setUsers(payload.users);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function patch(userId: string, patchBody: Record<string, unknown>, done: string) {
    setBusyId(userId);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, ...patchBody }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setMessage(done);
      await reload(q);
    } catch (caught) {
      setMessage(caught instanceof Error ? `⚠ ${caught.message}` : String(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function adjust() {
    if (!adjusting) return;
    const value = Number.parseInt(delta, 10);
    if (!Number.isInteger(value) || value === 0) {
      setMessage("⚠ 点数调整必须是整数且不为 0");
      return;
    }
    setBusyId(adjusting.id);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: adjusting.id, delta: value, note }),
      });
      const payload = (await response.json()) as { balance?: number; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setMessage(`✓ 已调整 ${adjusting.username} 的点数，当前余额 ${payload.balance}`);
      setAdjusting(null);
      setNote("");
      await reload(q);
    } catch (caught) {
      setMessage(caught instanceof Error ? `⚠ ${caught.message}` : String(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <input
          className="field-input max-w-xs"
          placeholder="搜索用户名…"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void reload(q);
          }}
        />
        <button className="btn-ghost px-4 py-2 font-mono text-xs" onClick={() => void reload(q)}>
          搜索
        </button>
        {message && <span className="font-mono text-xs text-ink-soft">{message}</span>}
      </div>

      <ul className="space-y-2">
        {users.map((user) => (
          <li key={user.id} className="rounded-xl border border-line bg-paper-card px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex w-[200px] shrink-0 items-center gap-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-[#3a342e] text-xs">
                  {user.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="font-display min-w-0 truncate text-[15px] font-bold">{user.username}</span>
                {user.role === "admin" && <span className="stamp text-[10px] text-seal">管理员</span>}
                {user.status !== "active" && <span className="stamp stamp-quiet text-[10px] text-ink-faint">停用</span>}
              </div>
              <div className="min-w-0 flex-1 font-mono text-[11px] text-ink-faint">
                余额 <span className="text-ink">{user.balance}</span> 点
                {" · 累充 "}<span className="text-ink">{user.totalGranted}</span>
                {" · 累耗 "}<span className="text-ink">{user.totalConsumed}</span>
                {user.subscription && (
                  <>
                    {" · "}
                    <span className="text-seal">{user.subscription.planName}</span>
                    {` 至 ${fmtDate(user.subscription.expiresAt)}`}
                  </>
                )}
                <div className="mt-0.5">注册 {fmtDate(user.createdAt)} · {user.authProvider}</div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <button
                  className="btn-ghost px-2.5 py-1 font-mono text-[11px]"
                  disabled={busyId === user.id}
                  onClick={() => {
                    setAdjusting(user);
                    setDelta("10");
                  }}
                >
                  调整点数
                </button>
                <button
                  className="btn-ghost px-2.5 py-1 font-mono text-[11px]"
                  disabled={busyId === user.id}
                  onClick={() =>
                    void patch(
                      user.id,
                      { role: user.role === "admin" ? "user" : "admin" },
                      user.role === "admin" ? `✓ 已将 ${user.username} 降为普通用户` : `✓ 已将 ${user.username} 提升为管理员`,
                    )
                  }
                >
                  {user.role === "admin" ? "降为用户" : "设为管理员"}
                </button>
                <button
                  className="btn-ghost px-2.5 py-1 font-mono text-[11px] hover:!border-seal hover:!text-seal"
                  disabled={busyId === user.id}
                  onClick={() =>
                    void patch(
                      user.id,
                      { status: user.status === "active" ? "disabled" : "active" },
                      user.status === "active" ? `✓ 已停用 ${user.username}` : `✓ 已启用 ${user.username}`,
                    )
                  }
                >
                  {user.status === "active" ? "停用" : "启用"}
                </button>
              </div>
            </div>
          </li>
        ))}
        {!loading && users.length === 0 && (
          <li className="rounded-xl border border-dashed border-line-dark bg-paper-card/40 px-5 py-8 text-center text-sm text-ink-faint">
            没有匹配的用户。
          </li>
        )}
        {loading && <li className="font-mono text-xs text-ink-faint">加载中…</li>}
      </ul>

      {adjusting && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#080706]/85 p-4 backdrop-blur-sm" onClick={() => setAdjusting(null)}>
          <div
            className="w-full max-w-sm rounded-[14px] border border-line bg-paper-deep p-7 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
              <h3 className="font-display text-lg font-bold">调整点数</h3>
              <span className="kicker">{adjusting.username}</span>
            </div>
            <div className="space-y-4">
              <div>
                <span className="field-label">变动点数（正数充值 / 负数扣减）</span>
                <input className="field-input mt-1 font-mono" value={delta} onChange={(event) => setDelta(event.target.value)} placeholder="如 10 / -5" />
              </div>
              <div>
                <span className="field-label">调整理由（必填）</span>
                <input className="field-input mt-1" value={note} onChange={(event) => setNote(event.target.value)} placeholder="调整原因" />
              </div>
              <p className="font-mono text-[11px] text-ink-faint">当前余额 {adjusting.balance} 点；理由会同步显示在用户订单与点数明细中。</p>
              {message?.startsWith("⚠") && <p className="font-mono text-xs text-seal">{message}</p>}
              <div className="flex justify-end gap-3 pt-1">
                <button className="btn-ghost px-5 py-2 text-sm" onClick={() => setAdjusting(null)}>
                  取消
                </button>
                <button className="btn-ink px-6 py-2 text-sm" disabled={busyId === adjusting.id} onClick={() => void adjust()}>
                  {busyId === adjusting.id ? "处理中…" : "确认调整"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
