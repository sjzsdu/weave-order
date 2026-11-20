import { z } from "zod";
import { BUSINESS_NAV, PRIMARY_NAV } from "./navigation";
import type { NavItem } from "./navigation";

/**
 * 工作台信息架构（IA）开关 —— WAN-196 / D4「事项 / 资源 / 设置」。
 *
 * 为什么放在 schema 而不是 web：导航、路由映射与灰度开关必须由同一份判定投影出来。
 * 页面、服务端重定向与 e2e 都读这里，避免出现「导航已经是新 IA、/today 却还在渲染旧页」。
 *
 * 判定顺序（两端一致）：
 * 1. 会话级覆盖 `weave_ia` cookie（运维/验收临时切回旧界面，仅影响路由展示）；
 * 2. 租户设置 `tenants.settings.workspaceIA`（缺省 = new，租户级灰度）；
 * 3. new。
 */

export const WorkspaceIA = z.enum(["new", "legacy"]);
export type WorkspaceIA = z.infer<typeof WorkspaceIA>;

/** 租户设置里保存 IA 模式的键。写入由平台管理员维护，本切片只读。 */
export const WORKSPACE_IA_SETTING = "workspaceIA";

/** 会话级覆盖 cookie。非法值按「没有覆盖」处理，绝不因为一个坏 cookie 把界面弄挂。 */
export const WORKSPACE_IA_COOKIE = "weave_ia";

export function resolveWorkspaceIA(
  tenantSettings: unknown,
  cookieOverride?: string | null,
): WorkspaceIA {
  if (cookieOverride === "legacy" || cookieOverride === "new") return cookieOverride;
  if (
    tenantSettings &&
    typeof tenantSettings === "object" &&
    !Array.isArray(tenantSettings) &&
    (tenantSettings as Record<string, unknown>)[WORKSPACE_IA_SETTING] === "legacy"
  ) {
    return "legacy";
  }
  return "new";
}

/**
 * 新 IA 一级入口：事项 / 资源 / 设置。
 * 审批不再是入口（D1 取消审批），日志归入设置里的「审计日志」。
 */
export const WORKSPACE_NAV: readonly NavItem[] = [
  { href: "/items", label: "事项", key: "1", hint: "⌘1" },
  { href: "/resources", label: "资源", key: "2", hint: "⌘2" },
  { href: "/settings", label: "设置", key: "3", hint: "⌘3" },
];

/**
 * 新 IA 的资源二级导航。
 *
 * 路由保持 `/panorama/*`：已分享给同事的客户/报价深链是真实资产，
 * `/resources` 只是新的「资源首页」，不引入第二套业务路径与双向重定向。
 */
export const RESOURCE_NAV: readonly NavItem[] = [
  { href: "/resources", label: "资源首页" },
  { href: "/panorama/customers", label: "客户" },
  { href: "/panorama/samples", label: "样品" },
  { href: "/resources/templates", label: "模板" },
];

/** 旧 IA 的一级/二级入口，保留给灰度回滚；与 `PRIMARY_NAV` 同源，避免两份定义漂移。 */
export const LEGACY_PRIMARY_NAV = PRIMARY_NAV;
export const LEGACY_BUSINESS_NAV = BUSINESS_NAV;

/**
 * 一级入口的「当前页」判定。
 *
 * - 精确匹配的一级页（资源首页/设置）只点亮自己；
 * - 新 IA 的「资源」同时覆盖 `/panorama/*` 深链（客户/样品仍住在旧路径上）；
 * - 事项覆盖 `/items/[id]`。
 */
export function isNavItemActive(href: string, pathname: string, ia: WorkspaceIA = "new"): boolean {
  if (href === "/resources") {
    if (pathname === href) return true;
    return ia === "new" && pathname.startsWith("/panorama");
  }
  if (href === "/settings") return pathname === href;
  // 旧业务概览必须精确匹配：否则客户/样品二级页会把「概览」也点亮。
  if (href === "/panorama") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
