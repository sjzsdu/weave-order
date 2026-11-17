"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ROLE_LABEL } from "./format";
import { LogoutForm } from "./logout-form";

const NAV: { group: string; items: { href: string; label: string }[] }[] = [
  {
    group: "经营",
    items: [
      { href: "/", label: "总览" },
      { href: "/tenants", label: "租户" },
      { href: "/billing", label: "订阅账单" },
      { href: "/usage", label: "用量" },
      { href: "/approvals", label: "待复核" },
    ],
  },
  {
    group: "商业化",
    items: [
      { href: "/pricing", label: "套餐与价格" },
      { href: "/settings/invoicing", label: "开票设置" },
    ],
  },
  {
    group: "平台",
    items: [
      { href: "/settings/llm", label: "LLM 设置" },
      { href: "/settings/identity", label: "身份" },
      { href: "/settings/feature-flags", label: "功能开关" },
      { href: "/settings/config", label: "配置中心" },
      { href: "/support", label: "支持 / Break-glass" },
      { href: "/audit", label: "平台审计" },
    ],
  },
];

export function ConsoleShell({
  actor,
  children,
}: {
  actor: { name: string; email: string; role: string; permissions: string[] };
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <p className="eyebrow">WANNIAO TECHNOLOGY</p>
          <p className="name">万鸟科技</p>
          <p className="sub">平台总管理端</p>
        </div>
        {NAV.map((group) => (
          <div className="nav-group" key={group.group}>
            <span className="label">{group.group}</span>
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link${isActive(item.href) ? " active" : ""}`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">
          <strong>{actor.name}</strong>
          <span>{ROLE_LABEL[actor.role] ?? actor.role}</span>
          <div style={{ marginTop: 6 }}>
            <LogoutForm buttonClassName="logout-button sidebar-logout">退出</LogoutForm>
          </div>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
