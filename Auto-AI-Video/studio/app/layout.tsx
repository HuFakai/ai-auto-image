import type { Metadata } from "next";
import { Newsreader, Public_Sans } from "next/font/google";
import { TaskNotificationMonitor } from "./task-notifications";
import { TaskCenter } from "./task-center";
import "./globals.css";

const display = Newsreader({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const body = Public_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pixelle Production Desk",
  description: "持续短视频生产、库存与任务控制台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="zh-CN"
      className={`${display.variable} ${body.variable}`}
      data-scroll-behavior="smooth"
    >
      <body><TaskNotificationMonitor /><TaskCenter />{children}</body>
    </html>
  );
}
