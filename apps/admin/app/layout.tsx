import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  // 每个页面只声明自己的名称（如 "租户"），品牌后缀由模板统一拼接，
  // 避免各页各写一遍品牌、也避免漏写导致所有标签页同名。
  title: {
    default: "万鸟科技 · 平台总管理端",
    template: "%s · 万鸟科技",
  },
  description: "控制面：租户、订阅、用量、账单与平台审计。",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#17212e",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
