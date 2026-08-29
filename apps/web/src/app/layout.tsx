import type { Metadata } from "next";
import { IBM_Plex_Mono, Noto_Sans_SC, Noto_Serif_SC } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { getCurrentUser } from "@/server/auth";
import UserBadge from "./user-badge";

const serif = Noto_Serif_SC({
  weight: ["600", "900"],
  variable: "--font-noto-serif-sc",
  preload: false,
});
const sans = Noto_Sans_SC({
  weight: ["400", "500", "700"],
  variable: "--font-noto-sans-sc",
  preload: false,
});
const mono = IBM_Plex_Mono({
  weight: ["400", "600"],
  subsets: ["latin"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "AI 图文工坊",
  description: "根据主题与文案，自动生成一套可发布的中文图文。",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  return (
    <html lang="zh-CN" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body className="grain">
        <header className="border-b border-line bg-paper">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
            <Link href="/" className="group flex items-center gap-3">
              <span className="seal h-9 w-9 text-lg leading-none">印</span>
              <span className="flex flex-col">
                <span className="font-display text-lg font-black leading-tight tracking-wide">
                  AI 图文工坊
                </span>
                <span className="font-mono text-[9px] tracking-[0.34em] text-ink-faint">
                  AUTO IMAGE PRESS
                </span>
              </span>
            </Link>
            <nav className="flex items-center gap-6 font-mono text-xs text-ink-soft">
              <Link href="/" className="hover:text-seal transition-colors">
                工作台
              </Link>
              {user?.role === "admin" && (
                <Link href="/settings" className="hover:text-seal transition-colors">
                  渠道设置
                </Link>
              )}
              <a href="/api/health" className="hidden hover:text-seal transition-colors sm:inline">
                HEALTH
              </a>
              {user ? (
                <UserBadge username={user.username} role={user.role} />
              ) : (
                <Link href="/login" className="hover:text-seal transition-colors">
                  登录
                </Link>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 pb-24">{children}</main>
        <footer className="border-t border-line-dark/60">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5 font-mono text-[10px] tracking-[0.18em] text-ink-faint">
            <span>AI AUTO IMAGE · 阶段〇</span>
            <span>纸感印刷 · 第壹版</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
