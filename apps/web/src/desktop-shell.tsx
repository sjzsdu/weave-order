"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useApprovals, useAuthContext } from "@weave-order/core";
import { Badge, CommandBar, OfflineBanner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { PrintDrawer } from "@/print-drawer";

const WINDOWS = [
  { href: "/today", label: "工作台", key: "1", hint: "⌘1" },
  { href: "/approvals", label: "审批", key: "2", hint: "⌘2" },
  { href: "/panorama", label: "全景", key: "3", hint: "⌘3" },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * 桌面外壳：顶栏 + 3 个业务窗口 + 组织设置（管理面）+ 全局打印抽屉。
 * 快捷键 ⌘1/⌘2/⌘3/⌘,，不抢输入焦点。
 */
export function DesktopShell({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper text-sm text-ink-400">
        正在连接织序…
      </div>
    );
  }
  return <DesktopShellContent>{children}</DesktopShellContent>;
}

function DesktopShellContent({ children }: { children: ReactNode }) {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const me = useAuthContext(api);
  const approvals = useApprovals(api);
  const [printOpen, setPrintOpen] = useState(false);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const map: Record<string, string> = {
        "1": "/today",
        "2": "/approvals",
        "3": "/panorama",
        ",": "/settings",
      };
      const target = map[event.key];
      if (target) {
        event.preventDefault();
        router.push(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const pending = approvals.data?.items.length ?? 0;
  const name = me.data?.name ?? me.data?.subject ?? "当前成员";
  const tenant = me.data?.tenant.name;

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-6 px-5">
          <Link href="/today" className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tracking-wide text-ink-900">织序</span>
            <span className="hidden text-xs text-ink-400 sm:inline">WeaveOrder</span>
          </Link>

          <nav aria-label="桌面窗口" className="flex items-center gap-1">
            {WINDOWS.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative inline-flex min-h-9 items-center gap-2 rounded-md px-3 text-sm",
                    active
                      ? "bg-indigo-100 font-medium text-indigo-600"
                      : "text-ink-700 hover:bg-surface",
                  )}
                >
                  {item.label}
                  {item.key === "2" && pending > 0 && <Badge tone="danger">{pending}</Badge>}
                </Link>
              );
            })}
          </nav>

          <div className="mx-auto hidden md:block">
            <CommandBar onSubmit={() => router.push("/today")} />
          </div>

          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPrintOpen(true)}
              className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-ink-700 hover:border-ink-400"
            >
              <span aria-hidden>⎙</span>
              打印
            </button>
            <Link
              href="/settings"
              aria-label="组织与设置（⌘,）"
              className={cn(
                "inline-flex min-h-9 items-center gap-2 rounded-md px-3 text-sm",
                pathname.startsWith("/settings")
                  ? "bg-indigo-100 text-indigo-600"
                  : "text-ink-700 hover:bg-surface",
              )}
            >
              {name}
              <span className="text-xs text-ink-400">⌘,</span>
            </Link>
            <a href="/auth/logout" className="text-xs text-ink-400 underline underline-offset-2">
              退出
            </a>
          </div>
        </div>
        {!online && (
          <div className="mx-auto max-w-[1440px] px-5 pb-2">
            <OfflineBanner pending={0} />
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1440px] px-5 py-6">
        {tenant && <p className="mb-3 text-xs text-ink-400">{tenant} · 桌面端</p>}
        {children}
      </main>

      <footer className="mx-auto mt-8 max-w-[1440px] border-t border-line px-5 py-4 text-xs text-ink-400">
        3 个业务窗口 + 1 个管理面 · 打印是全局抽屉 · 前端只读展示 + 发起审批，金额与阈值一律后端校验。
      </footer>

      <PrintDrawer open={printOpen} onClose={() => setPrintOpen(false)} />
    </div>
  );
}
