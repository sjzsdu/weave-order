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
          部署期配置：官网地址与支持邮箱由容器环境变量决定，运行时读取。
          defer 保证在 hydration 之前执行；内容来自本服务的 /config.js，
          不用 NEXT_PUBLIC_*（那会把域名内联进构建产物）。
        */}
        <script src="/config.js" defer />
      </head>
      <body>
        <ClientRoot>{children}</ClientRoot>
      </body>
    </html>
  );
}
