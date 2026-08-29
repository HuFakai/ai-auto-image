"use client";

export default function UserBadge({ username, role }: { username: string; role: "admin" | "user" }) {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }
  return (
    <span className="flex items-center gap-3">
      <span className="hidden font-mono text-[11px] text-ink-soft sm:inline">
        {username}
        {role === "admin" && <span className="ml-1 text-seal">·ADMIN</span>}
      </span>
      <button
        type="button"
        onClick={logout}
        className="rounded border border-line px-2.5 py-1 font-mono text-[11px] text-ink-soft transition-colors hover:border-seal hover:text-seal"
      >
        退出
      </button>
    </span>
  );
}
