"use client";

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { track } from "@/analytics";
import type { AnalyticsEvent } from "@/analytics";

/**
 * 需要埋点的链接。服务端渲染的页面（例如 /login）没法直接写 onClick，
 * 用它包一层即可：先上报，再交给原生 <a> 跳转。
 */
export function TrackedLink({
  event,
  eventProps,
  children,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  event: AnalyticsEvent;
  eventProps?: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <a
      {...rest}
      onClick={(clickEvent) => {
        track(event, eventProps);
        onClick?.(clickEvent);
      }}
    >
      {children}
    </a>
  );
}
