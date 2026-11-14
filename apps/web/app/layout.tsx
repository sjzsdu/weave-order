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
      <head>
        {/*
          部署期配置（目前只有访问统计）：由本服务的 /config.js 按容器环境变量生成。
          defer 保证它在 hydration 前执行，客户端再用 weave:config 事件收到值。
        */}
        <script src="/config.js" defer />
      </head>
      <body>
        <ClientRoot>{children}</ClientRoot>
      </body>
    </html>
  );
}
