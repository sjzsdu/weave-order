import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ConsoleShell } from "@/src/console-shell";
import { PlatformApiError, currentActor } from "@/src/server-api";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  try {
    const actor = await currentActor();
    return <ConsoleShell actor={actor}>{children}</ConsoleShell>;
  } catch (error) {
    if (error instanceof PlatformApiError && error.status === 401) {
      redirect(`/login?${new URLSearchParams({ error: "会话已失效，请重新登录" }).toString()}`);
    }
    // 生产环境 Next 会把服务端错误详情从浏览器剥掉（只剩 digest），
    // 所以这里必须留一条结构化日志，docker logs weave-admin 才能定位。
    console.error("[admin] 控制台布局加载失败", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
