"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  {
    href: "/",
    label: "工作台",
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M3 12l9-8 9 8M5 10v10h14V10" />
      </svg>
    ),
  },
  {
    href: "/runs",
    label: "作品库",
    icon: (
      <svg viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 10h18M9 4v16" />
      </svg>
    ),
  },
  {
    href: "/pricing",
    label: "充值",
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v10M9.5 9.5h5M9.5 12.5h5" />
      </svg>
    ),
  },
  {
    href: "/settings",
    label: "品牌手册",
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
      </svg>
    ),
  },
  {
    href: "/admin",
    label: "管理后台",
    icon: (
      <svg viewBox="0 0 24 24">
        <rect x="3" y="3" width="8" height="8" rx="1.5" />
        <rect x="13" y="3" width="8" height="8" rx="1.5" />
        <rect x="3" y="13" width="8" height="8" rx="1.5" />
        <rect x="13" y="13" width="8" height="8" rx="1.5" />
      </svg>
    ),
  },
];

/** 方案 A:左侧 64px 图标导航 */
export function SideNav({ isAdmin, username }: { isAdmin: boolean; username: string | null }) {
  const pathname = usePathname();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }
  return (
    <nav className="sticky top-0 flex h-screen w-16 flex-col items-center gap-1.5 border-r border-line bg-paper-deep py-3.5">
      <Link href="/" className="seal mb-4 grid h-9 w-9 place-items-center text-base">
        印
      </Link>
      {ITEMS.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const hidden = (item.href === "/settings" || item.href === "/admin") && !isAdmin;
        if (hidden) return null;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            className={`group relative grid h-11 w-11 place-items-center rounded-[10px] transition-colors ${
              active ? "bg-[#2a201c] text-seal" : "text-ink-faint hover:bg-[#241f1b] hover:text-ink"
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
              {item.icon}
            </svg>
            <span className="pointer-events-none absolute left-[54px] z-50 whitespace-nowrap rounded-md border border-line bg-[#2a2521] px-2.5 py-1 text-xs text-ink opacity-0 transition-opacity group-hover:opacity-100">
              {item.label}
            </span>
          </Link>
        );
      })}
      <div className="mt-auto flex flex-col items-center gap-2">
        {username ? (
          <>
            <div
              className="grid h-9 w-9 place-items-center rounded-full border border-line bg-[#3a342e] text-xs text-ink"
              title={username}
            >
              {username.slice(0, 1).toUpperCase()}
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              title="退出登录"
              className="grid h-9 w-9 place-items-center rounded-[10px] text-ink-faint transition-colors hover:bg-[#241f1b] hover:text-seal"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M15 12H4m4-4l-4 4 4 4M11 4h7a2 2 0 012 2v12a2 2 0 01-2 2h-7" />
              </svg>
            </button>
          </>
        ) : (
          <Link
            href="/login"
            title="登录"
            className="grid h-9 w-9 place-items-center rounded-[10px] text-ink-faint transition-colors hover:bg-[#241f1b] hover:text-ink"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c1.5-4 5-5 8-5s6.5 1 8 5" />
            </svg>
          </Link>
        )}
      </div>
    </nav>
  );
}
