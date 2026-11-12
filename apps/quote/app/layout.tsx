import type { Metadata, Viewport } from "next";
import "./globals.css";

/**
 * 客户报价页是产品唯一的外部界面：不索引、不追踪、不加载第三方脚本。
 */
export const metadata: Metadata = {
  title: "报价单 · Quotation",
  description: "客户专属报价单，无需登录即可查看、提问与接受。",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
