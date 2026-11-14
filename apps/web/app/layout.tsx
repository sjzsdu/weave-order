import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ClientRoot } from "./client-root";
import "./globals.css";

export const metadata: Metadata = {
  title: "织序 WeaveOrder · 智能体原生纺织业务系统",
  description: "智能体起草，人审批。工作台、审批与全景三个窗口。",
  // 登录后的工作台不需要被搜索引擎收录；官网与帮助中心负责对外。
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F7F4EE",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <ClientRoot>{children}</ClientRoot>
      </body>
    </html>
  );
}
