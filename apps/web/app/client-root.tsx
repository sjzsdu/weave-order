"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { Analytics } from "@/analytics-tracker";
import { DocumentTitle } from "@/document-title";

/**
 * 桌面端是登录后的纯客户端应用：整棵客户端树不在服务端预渲染，
 * 避免服务端打包与 packages/core 各解析一份 react-query context。
 */
const Providers = dynamic(() => import("@/providers").then((mod) => mod.AppProviders), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-screen items-center justify-center bg-paper text-sm text-ink-400">
      正在连接织序…
    </div>
  ),
});

export function ClientRoot({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <DocumentTitle />
      <Analytics />
      {children}
    </Providers>
  );
}
