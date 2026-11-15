"use client";

import type { Capability } from "@weave-order/schema";
import type { ReactNode } from "react";
import { useCapability } from "@weave-order/core";
import { useApi } from "@/providers";

/**
 * 当前成员是否具备某能力。
 *
 * 判断只来自 `/api/auth/me` 的 `capabilities`（服务端按
 * `packages/schema/src/capabilities.ts` 计算），前端不再拿 `membership.role`
 * 自己比字符串——那样迟早会和后端漂移成两份真相。
 */
export function useCan(capability: Capability): boolean {
  return useCapability(useApi(), capability);
}

/**
 * 按能力显示/隐藏子树。
 *
 * `fallback` 用于「能力不足时给替代内容」（例如提示文案），默认什么都不渲染。
 * 注意：这只是可见性，真正的鉴权永远在后端；这里只保证界面不诱导越权操作。
 */
export function Can({
  cap,
  children,
  fallback = null,
}: {
  cap: Capability;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return <>{useCan(cap) ? children : fallback}</>;
}
