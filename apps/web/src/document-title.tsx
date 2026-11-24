"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const BASE_TITLE = "织序 WeaveOrder · 智能体原生纺织业务系统";

export function titleForPath(pathname: string): string {
  if (pathname === "/login" || pathname.startsWith("/login?")) return "登录 · 织序 WeaveOrder";
  if (pathname === "/workbench" || pathname === "/today") return "工作台 · 织序 WeaveOrder";
  if (pathname === "/items" || pathname.startsWith("/items/")) return "事项 · 织序 WeaveOrder";
  if (
    pathname === "/resources" ||
    pathname.startsWith("/resources/") ||
    pathname.startsWith("/panorama")
  ) {
    return "资源 · 织序 WeaveOrder";
  }
  if (pathname === "/settings" || pathname.startsWith("/settings?")) {
    return "设置 · 织序 WeaveOrder";
  }
  if (pathname === "/inbound" || pathname.startsWith("/inbound?")) {
    return "对小织说句话 · 织序 WeaveOrder";
  }
  if (pathname === "/xiaozhi" || pathname.startsWith("/xiaozhi?")) {
    return "小织 · 织序 WeaveOrder";
  }
  return BASE_TITLE;
}

/**
 * 每个页面有独立的浏览器标题（WAN-211 UX-007）：多 tab 使用时能一眼分清。
 * 桌面页都是客户端渲染，放最外层用 pathname 同步 document.title，
 * 不必在几十个页面里各写一份 generateMetadata。
 */
export function DocumentTitle() {
  const pathname = usePathname();
  useEffect(() => {
    document.title = titleForPath(pathname);
  }, [pathname]);
  return null;
}
