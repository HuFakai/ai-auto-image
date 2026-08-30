import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser } from "@/server/auth";
import { SideNav } from "./side-nav";

export const metadata: Metadata = {
  title: "AI 图文工坊",
  description: "根据主题与文案,自动生成一套可发布的中文图文。",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  return (
    <html lang="zh-CN">
      <body>
        <div className="grid min-h-screen grid-cols-[64px_1fr] max-md:grid-cols-[56px_1fr]">
          <SideNav isAdmin={user?.role === "admin"} username={user?.username ?? null} />
          <main className="min-w-0">{children}</main>
        </div>
      </body>
    </html>
  );
}
