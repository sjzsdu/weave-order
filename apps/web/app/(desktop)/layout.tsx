import type { ReactNode } from "react";
import { DesktopShell } from "@/desktop-shell";

/** 桌面工作区全部依赖登录会话与实时数据，不做静态预渲染。 */
export const dynamic = "force-dynamic";

export default function DesktopLayout({ children }: { children: ReactNode }) {
  return <DesktopShell>{children}</DesktopShell>;
}
