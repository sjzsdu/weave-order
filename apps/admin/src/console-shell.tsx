"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ADMIN_TIME_ZONE_LABEL, ROLE_LABEL } from "./format";
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

/** 与 globals.css 的侧栏折叠断点保持一致。 */
const MOBILE_QUERY = "(max-width: 860px)";

export function ConsoleShell({
  actor,
  children,
}: {
  actor: { name: string; email: string; role: string; permissions: string[] };
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  // 桌面端侧栏常驻；只有移动端抽屉关闭时才把侧栏移出可聚焦序列。
  const [isMobile, setIsMobile] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  // 换页后收起抽屉，避免移动端导航盖住新页面。
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const sync = () => {
      setIsMobile(query.matches);
      if (!query.matches) setNavOpen(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // 抽屉打开时锁住正文滚动，避免背景页面跟着上下滑。
  useEffect(() => {
    if (!navOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [navOpen]);

  useEffect(() => {
    if (!navOpen) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setNavOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navOpen]);

  const closeNav = () => setNavOpen(false);
  const hiddenFromA11y = isMobile && !navOpen;

  return (
    <div className={`shell${navOpen ? " nav-open" : ""}`}>
      <a className="skip-link" href="#main">
        跳到主内容
      </a>
      <header className="mobile-bar">
        <button
          ref={toggleRef}
          type="button"
          className="nav-toggle"
          aria-expanded={navOpen}
          aria-controls="console-nav"
          aria-label={navOpen ? "关闭导航" : "打开导航"}
          onClick={() => setNavOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path
              d="M3 6h18M3 12h18M3 18h18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <span className="mobile-bar__brand">
          <strong>万鸟科技</strong>
          <span>平台总管理端</span>
        </span>
      </header>
      <button
        type="button"
        className="sidebar-backdrop"
        aria-label="关闭导航"
        tabIndex={-1}
        onClick={closeNav}
      />
      <aside
        id="console-nav"
        className="sidebar"
        aria-label="主导航"
        aria-hidden={hiddenFromA11y || undefined}
        // inert 让抽屉关闭时的链接不参与 Tab / 读屏，桌面端始终可交互。
        inert={hiddenFromA11y}
      >
        <button
          ref={closeRef}
          type="button"
          className="sidebar-close"
          aria-label="关闭导航"
          onClick={closeNav}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
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
                aria-current={isActive(item.href) ? "page" : undefined}
                onClick={closeNav}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">
          <strong>{actor.name}</strong>
          <span>{ROLE_LABEL[actor.role] ?? actor.role}</span>
          <span className="tiny muted" style={{ display: "block", marginTop: 4 }}>
            时间按{ADMIN_TIME_ZONE_LABEL}显示
          </span>
          <div style={{ marginTop: 6 }}>
            <LogoutForm buttonClassName="logout-button sidebar-logout">退出</LogoutForm>
          </div>
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
