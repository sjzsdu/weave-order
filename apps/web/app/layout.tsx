import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ClientRoot } from "./client-root";
import "./globals.css";

export const metadata: Metadata = {
  title: "织序 WeaveOrder · 智能体原生纺织业务系统",
  description: "AI 智能体出草稿，人类只做审批。",
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
