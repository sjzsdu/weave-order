import { cookies } from "next/headers";
import { WORKSPACE_IA_COOKIE, resolveWorkspaceIA } from "@weave-order/schema";
import type { WorkspaceIA } from "@weave-order/schema";
import { isProductionLike } from "@/runtime-mode";

/**
 * 服务端 IA 判定：`/today`、`/panorama` 的历史书签要靠它决定「跳新路由还是渲染旧页面」。
 *
 * 为什么服务端读 `/api/auth/me` 而不是让客户端 `router.replace`：
 * 308/307 语义要真的在响应上（书签、分享链接、爬虫都按 30x 处理），客户端跳转会先
 * 渲染一帧旧页面。代价是每次命中这两个旧入口多一次按主键的读，可接受。
 *
 * 租户设置读不到时默认新 IA：宁可把用户带到事项页，也不要让一次 API 抖动把
 * 整个首页卡成旧界面（新 IA 本身不破坏旧路由）。
 */
export async function resolveWorkspaceIAServer(): Promise<WorkspaceIA> {
  const jar = await cookies();
  const override = jar.get(WORKSPACE_IA_COOKIE)?.value ?? null;
  // 会话级覆盖是同步的：命中就不必再打一次 API。
  if (override === "legacy" || override === "new") return override;

  const token = jar.get("weave_token")?.value;
  const sid = jar.get("weave_sid")?.value;
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  else if (!isProductionLike()) {
    headers.set("authorization", `Bearer ${process.env.DEV_AUTH_TOKEN ?? "dev:demo:demo"}`);
  } else {
    return "new";
  }
  if (sid) headers.set("cookie", `weave_sid=${sid}`);

  const base = (process.env.API_PROXY_TARGET ?? "http://localhost:3000").replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/api/auth/me`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return "new";
    const me: unknown = await response.json();
    if (!me || typeof me !== "object" || !("tenant" in me)) return "new";
    const tenant = (me as { tenant?: { settings?: unknown } }).tenant;
    return resolveWorkspaceIA(tenant?.settings);
  } catch {
    // API 不可达时不让入口 404 / 500：按新 IA 继续（/items 自身会显示错误态）。
    return "new";
  }
}
