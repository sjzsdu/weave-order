"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApprovals, useTenantContext } from "@weave-order/core";
import type { TenantChoice } from "@weave-order/schema";
import { Badge, CommandBar, OfflineBanner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { PrintDrawer } from "@/print-drawer";
import { NoMembershipNotice, TenantChooser, TenantSwitcher } from "@/tenant-switch";

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

/** 切换失败的文案：租户不可用给具体原因，其余保持契约里的服务端消息。 */
function switchErrorText(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) {
    return error.message;
  }
  return "切换失败，请稍后重试";
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
  const tenantContext = useTenantContext(api);
  const [printOpen, setPrintOpen] = useState(false);
  const [switcherSignal, setSwitcherSignal] = useState(0);
  const [online, setOnline] = useState(true);

  // 只有已进入工作台才需要知道「我还有哪些公司」；单租户账号这里拿到 1 条，
  // TenantSwitcher 据此不渲染切换入口。
  const tenantList = useQuery({
    queryKey: ["auth", "tenants"],
    queryFn: () => api.tenants(),
    enabled: tenantContext.status === "READY",
    staleTime: 60_000,
  });

  /**
   * 切租户 = 换一整套上下文。成功即整页重建：不保留旧租户的 query 缓存、
   * 审批角标或打印抽屉状态，避免「新租户标题 + 旧租户数据」的混搭。
   */
  const switchTenant = async (tenantId: string) => {
    try {
      await tenantContext.select(tenantId);
      window.location.replace("/today");
    } catch {
      // 失败保持当前页面；错误由 tenantContext.switchError 渲染。
    }
  };

  const approvals = useApprovals(api);

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
      // ⌘⇧O：打开「当前公司」切换器（与 ⌘1/2/3 不冲突）。
      if (event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setSwitcherSignal((value) => value + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  // 新用户第一次登录时还没有任何公司：别让他对着一个空工作台发愣，
  // 直接给两条路——自己开一间，或去打开同事发来的邀请链接。
  if (me.isError && /成员身份/.test(me.error instanceof Error ? me.error.message : "")) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="max-w-md rounded-lg border border-line bg-surface px-6 py-6">
          <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
          <h1 className="mt-2 text-xl font-semibold text-ink-900">你还没有加入任何公司</h1>
          <p className="mt-2 text-sm text-ink-500">
            第一次用就自己创建一间公司，填个名字就能开始；如果是同事邀请你，打开他发你的邀请链接接受即可。
          </p>
          <a
            href="/start"
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
          >
            创建公司
          </a>
          <a
            href="/login"
            className="mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
          >
            换个账号登录
          </a>
          <p className="mt-4 text-xs text-ink-400">邀请链接 7 天内有效，通常在你的微信或邮件里。</p>
        </div>
      </div>
    );
  }

  const pending = approvals.data?.items.length ?? 0;
  const pendingMore = approvals.data?.hasMore === true;
  const pendingLabel = pendingMore ? `${pending}+` : pending;

  // 选择页 / 零租户页是登录态的一部分，必须在工作台外壳之前渲染：
  // 此时还没有租户，顶栏的待办、打印、设置都没有意义。
  if (tenantContext.status === "LOADING") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper text-sm text-ink-400">
        正在连接织序…
      </div>
    );
  }
  if (tenantContext.status === "MULTI_TENANT") {
    return (
      <TenantChooser
        tenants={tenantContext.tenants}
        switching={tenantContext.switching}
        error={switchErrorText(tenantContext.switchError)}
        onSelect={(tenantId) => void switchTenant(tenantId)}
      />
    );
  }
  if (tenantContext.status === "NO_MEMBERSHIP") {
    return <NoMembershipNotice message={tenantContext.message} />;
  }
  if (tenantContext.status === "ERROR") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[480px] flex-col justify-center px-5">
        <h1 className="text-xl font-semibold text-ink-900">登录状态异常</h1>
        <p className="mt-2 text-sm text-ink-400">{tenantContext.message}</p>
        <a href="/auth/logout" className="mt-6 text-sm text-indigo-600 underline">
          重新登录
        </a>
      </main>
    );
  }

  const tenant = tenantContext.tenant;
  const membership = tenantContext.membership;
  const name = membership.subject;
  const tenants: TenantChoice[] = tenantList.data?.tenants ?? [];

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
                  {item.key === "2" && pending > 0 && <Badge tone="danger">{pendingLabel}</Badge>}
                </Link>
              );
            })}
          </nav>

          <div className="mx-auto hidden md:block">
            <CommandBar onSubmit={() => router.push("/today")} />
          </div>

          <div className="ml-auto flex items-center gap-3">
            <TenantSwitcher
              tenants={
                tenants.length > 0
                  ? tenants
                  : [
                      {
                        tenantId: tenant.id,
                        slug: tenant.slug,
                        name: tenant.name,
                        brand: tenant.brand,
                        role: membership.role,
                        tenantStatus: tenant.status,
                        membershipStatus: membership.status,
                        available: true,
                      },
                    ]
              }
              current={{ tenantId: tenant.id, name: tenant.name }}
              onSelect={(tenantId) => void switchTenant(tenantId)}
              openSignal={switcherSignal}
            />
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
        <p className="mb-3 text-xs text-ink-400">{tenant.name} · 桌面端</p>
        {children}
      </main>

      <footer className="mx-auto mt-8 max-w-[1440px] border-t border-line px-5 py-4 text-xs text-ink-400">
        3 个业务窗口 + 1 个管理面 · 打印是全局抽屉 · 前端只读展示 +
        发起审批，金额与阈值一律后端校验。
      </footer>

      <PrintDrawer open={printOpen} onClose={() => setPrintOpen(false)} />
    </div>
  );
}
