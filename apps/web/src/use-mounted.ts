"use client";

import { useEffect, useState } from "react";

/**
 * 桌面应用是纯客户端：首帧返回 false，避免 react-query hooks 在 SSR 阶段执行。
 * 守卫必须放在调用 hooks 的组件本体内（路由段会被服务端单独预渲染）。
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
