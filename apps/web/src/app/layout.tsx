import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser } from "@/server/auth";
import { SideNav } from "./side-nav";

export const metadata: Metadata = {
  title: "图叙 · StoryFrame",
  description: "把主题、文章与资料变成可发布的视觉故事。",
  icons: {
    icon: [
      { url: "/brand/logo/logo-mark.svg", type: "image/svg+xml" },
      { url: "/brand/logo/logo-mark.png", type: "image/png" },
    ],
    apple: "/brand/logo/logo-mark.png",
  },
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
