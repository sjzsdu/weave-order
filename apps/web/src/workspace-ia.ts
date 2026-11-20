"use client";

import { useAuthContext } from "@weave-order/core";
import { WORKSPACE_IA_COOKIE, resolveWorkspaceIA } from "@weave-order/schema";
import type { WorkspaceIA } from "@weave-order/schema";
import { useApi } from "@/providers";

function readOverrideCookie(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${WORKSPACE_IA_COOKIE}=`;
  for (const chunk of document.cookie.split(";")) {
    const trimmed = chunk.trim();
    if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
  }
  return null;
}

/**
 * 浏览器侧 IA 判定，与服务端 `resolveWorkspaceIAServer()` 同一份优先级：
 * cookie 覆盖 > 租户设置 workspaceIA > new。
 *
 * 只读 `/api/auth/me` 里的租户设置（已随上下文一起返回），不额外发请求；
 * 加载中 / 待选租户时按新 IA（首帧只有很少的路由判断会用到）。
 */
export function useWorkspaceIA(): WorkspaceIA {
  const api = useApi();
  const me = useAuthContext(api);
  const data = me.data;
  const settings = data && !("tenants" in data) ? data.tenant.settings : null;
  return resolveWorkspaceIA(settings, readOverrideCookie());
}
