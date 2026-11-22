import type { Capability } from "./capabilities";

/**
 * 导航的唯一事实源：菜单项 → 所需能力。
 *
 * 为什么放 `packages/schema` 而不是前端：菜单可见性与后端 403 必须由同一份能力集合
 * 投影出来。页面各自写 `role === "..."` 时，加一个角色或调一条权限就必然出现
 * 「前端藏了后端还能调」或「有权限但找不到入口」。这里只放纯数据 + 纯函数，
 * 桌面端、移动端与未来的设置页共用。
 */

export interface NavItem {
  href: string;
  label: string;
  /** 快捷键数字（⌘1…），仅一级入口使用。 */
  key?: string;
  hint?: string;
  /** 缺省 = 所有 ACTIVE 成员可见。 */
  requiredCapability?: Capability;
}

/** 桌面一级入口。快捷键顺序与 WAN-174 §4.1 一致。 */
export const PRIMARY_NAV: readonly NavItem[] = [
  { href: "/today", label: "工作台", key: "1", hint: "⌘1" },
  { href: "/approvals", label: "审批", key: "2", hint: "⌘2", requiredCapability: "quote.approve" },
  { href: "/panorama", label: "业务", key: "3", hint: "⌘3" },
  { href: "/logs", label: "日志", key: "4", hint: "⌘4", requiredCapability: "audit.read.own" },
];

/**
 * 业务二级导航。
 *
 * 路由保持 `/panorama/*`（WAN-174 §4.1）：已分享的客户/报价深链是真实资产，
 * 不能为了 URL 好看而引入 `/business/*` 与双向重定向。
 */
export const BUSINESS_NAV: readonly NavItem[] = [
  { href: "/panorama", label: "概览" },
  { href: "/panorama/customers", label: "客户" },
  { href: "/panorama/samples", label: "样品" },
  { href: "/panorama/quotes", label: "报价", requiredCapability: "quote.workbench.view" },
  { href: "/panorama/orders", label: "订单", requiredCapability: "panorama.orders.view" },
  { href: "/panorama/receivables", label: "应收", requiredCapability: "receivable.read" },
];

/** 设置页左侧分栏。 */
export const SETTINGS_SECTIONS: readonly NavItem[] = [
  {
    href: "/settings?section=organization",
    label: "组织资料",
    requiredCapability: "settings.edit",
  },
  {
    href: "/settings?section=members",
    label: "成员与权限",
    requiredCapability: "member.invite",
  },
  {
    href: "/settings?section=fields",
    label: "客户与字段",
    requiredCapability: "field_options.manage",
  },
  { href: "/settings?section=input", label: "输入与识别", requiredCapability: "settings.edit" },
  {
    href: "/settings?section=units",
    label: "计量单位",
    requiredCapability: "settings.edit",
  },
  {
    href: "/settings?section=codes",
    label: "业务编号",
    requiredCapability: "settings.edit",
  },
  { href: "/settings?section=print", label: "打印与外设", requiredCapability: "settings.edit" },
  { href: "/settings?section=import", label: "数据导入", requiredCapability: "data.import" },
  { href: "/settings?section=audit", label: "审计日志", requiredCapability: "audit.read.own" },
  { href: "/settings?section=billing", label: "用量与订阅", requiredCapability: "billing.view" },
];

/**
 * 按能力过滤导航项。缺默认能力即全员可见，**不做角色判断**。
 * 传入的 `capabilities` 必须是服务端 `/api/auth/me` 下发的同一份能力集合。
 */
export function visibleNav(
  items: readonly NavItem[],
  capabilities: readonly Capability[],
): NavItem[] {
  return items.filter(
    (item) =>
      item.requiredCapability === undefined || capabilities.includes(item.requiredCapability),
  );
}
