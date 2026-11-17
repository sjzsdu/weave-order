import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ConsoleShell } from "@/src/console-shell";
import { PlatformApiError, currentActor } from "@/src/server-api";

export const dynamic = "force-dynamic";

/**
 * 控制台会话分流（会话失效的唯一判定点是控制面验签，不是 middleware）：
 * - 401：令牌真的无效/过期 → 回登录页（这是正常的会话超时，不是 bug）。
 * - 403：令牌有效但账号无权限 → no-access 页，**绝不清 cookie、绝不自动登出**。
 *   过去 403 会被 throw 到 error.tsx，而错误页把「重新登录」当首要操作，
 *   用户点一下就被 `/auth/logout` 清掉会话——表现为「点菜单被登出」。
 * - 其他（5xx / 网络）：保留结构化日志后抛出，交给 error.tsx 展示重试。
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  let actor;
  try {
    actor = await currentActor();
  } catch (error) {
    if (error instanceof PlatformApiError && error.status === 401) {
      redirect(`/login?${new URLSearchParams({ error: "会话已失效，请重新登录" }).toString()}`);
    }
    if (error instanceof PlatformApiError && error.status === 403) {
      const params = new URLSearchParams({ reason: error.message });
      redirect(`/no-access?${params.toString()}`);
    }
    // 生产环境 Next 会把服务端错误详情从浏览器剥掉（只剩 digest），
    // 所以这里必须留一条结构化日志，docker logs weave-admin 才能定位。
    console.error("[admin] 控制台布局加载失败", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return <ConsoleShell actor={actor}>{children}</ConsoleShell>;
}
