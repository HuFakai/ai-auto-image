import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 图文工坊 — 自动生成可发布图文",
  description: "根据主题、文案、文章、URL 或商品资料自动生成成套图文",
};

const NAV = [
  { href: "/", label: "项目" },
  { href: "/library", label: "资产库" },
  { href: "/calendar", label: "日历" },
  { href: "/workflows", label: "工作流" },
  { href: "/admin", label: "运营" },
  { href: "/settings", label: "设置" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <header className="sticky top-0 z-40 border-b border-line bg-paper/85 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
            <Link href="/" className="group flex items-baseline gap-2.5">
              <span className="font-display text-lg font-bold tracking-tight">
                图文<span className="text-accent">工坊</span>
              </span>
              <span className="hidden text-[11px] tracking-[0.2em] text-ink-3 sm:inline">AI AUTO IMAGE</span>
            </Link>
            <nav className="flex items-center gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-3 py-1.5 text-sm text-ink-2 transition-colors hover:bg-ink/5 hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
              <Link href="/projects/new" className="btn btn-accent ml-2 !py-1.5 !text-[13px]">
                新建项目
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 pb-24 pt-8">{children}</main>
        <footer className="border-t border-line py-6 text-center text-xs text-ink-3">
          AI 图文工坊 · 单机部署 · SQLite 持久卷 · 双文字渲染模式
        </footer>
      </body>
    </html>
  );
}
