"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApprovals, useIntentChannel, useTenantContext } from "@weave-order/core";
import type { TenantChoice } from "@weave-order/schema";
import { Badge, CommandBar, IntentRunCard, OfflineBanner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { PrintDrawer } from "@/print-drawer";
import { PersonaBar } from "@/persona-bar";
import { appVersionLabel, footerBrandLabel } from "@/format";
import { SUPPORT_EMAIL, SupportMailto } from "@/support";
import { NoMembershipNotice, TenantChooser, TenantSwitcher } from "@/tenant-switch";

/**
 * 页脚只留版本与帮助：内部工程口径（几个窗口、只读与否）不属于用户界面。
 * 版本由镜像构建期的语义化 tag 注入（见 scripts/build_push_images.sh）；没有注入时
 * 不显示版本，绝不回落到写死的旧版本号。commit 只作版本附注，不单独显示。
 */
const APP_VERSION = appVersionLabel(process.env.NEXT_PUBLIC_APP_VERSION);
const GIT_COMMIT = process.env.NEXT_PUBLIC_GIT_COMMIT;

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
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const [online, setOnline] = useState(true);

  // 窄屏「更多」是兜底入口：换页就收起，避免残留菜单盖住新页面。
  useEffect(() => setMoreOpen(false), [pathname]);

  // 点外面 / Esc 也要能收起：375 下菜单浮在内容上，只靠再点一次「更多」太反直觉。
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMoreOpen(false);
      moreButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

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
  // 顶栏与页内 composer 共用同一个意图 hook：同一份幂等键策略、同一份轮询与缓存。
  const intentChannel = useIntentChannel(api);

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
  // SSO 主键（subject）绝不能出现在界面上：先姓名，再邮箱，最后兜底「我」。
  const name = tenantContext.name?.trim() || tenantContext.email?.trim() || "我";
  const tenants: TenantChoice[] = tenantList.data?.tenants ?? [];
  // 窄屏没有顶栏的 TenantSwitcher：把可切换的公司直接列进「更多」，
  // 否则 375 宽度下「功能存在但入口消失」。
  const switchableTenants = tenants.filter(
    (choice) => choice.available && choice.tenantId !== tenant.id,
  );

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-3 md:gap-6 md:px-5">
          <Link href="/today" className="flex shrink-0 items-baseline gap-2 whitespace-nowrap">
            <span className="text-lg font-semibold tracking-wide text-ink-900">织序</span>
            <span className="hidden text-xs text-ink-400 sm:inline">WeaveOrder</span>
          </Link>

          <nav aria-label="桌面窗口" className="flex shrink-0 items-center gap-0.5 md:gap-1">
            {WINDOWS.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative inline-flex min-h-9 items-center gap-1 whitespace-nowrap rounded-md px-2 text-sm md:gap-2 md:px-3",
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
            <CommandBar
              onSubmit={async (text) => (await intentChannel.submit(text, "command-bar")) !== null}
              commands={[
                {
                  label: "建客户",
                  hint: "打开新建客户",
                  run: () => router.push("/panorama/customers?new=1"),
                },
                {
                  label: "建样品",
                  hint: "打开新建样品",
                  run: () => router.push("/panorama/samples?new=1"),
                },
                {
                  label: "导入客户",
                  hint: "CSV 批量导入",
                  run: () => router.push("/panorama/customers?import=1"),
                },
              ]}
              feedback={
                <div className="grid gap-2">
                  <p className="text-xs text-ink-400">
                    打「建客户 / 建样品 / 导入客户」回车直达，其他文字交给小织；结果展开在这里，10
                    分钟内可撤销。
                  </p>
                  {intentChannel.submitError && (
                    <p className="rounded-md border border-vermilion-600/30 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
                      {intentChannel.submitError}
                    </p>
                  )}
                  {intentChannel.items.slice(0, 3).map((intent) => (
                    <IntentRunCard
                      key={intent.id}
                      intent={intent}
                      busy={intentChannel.submitting}
                      onCancel={(id) => void intentChannel.cancel(id)}
                      onRetry={(item) => void intentChannel.retry(item)}
                    />
                  ))}
                </div>
              }
            />
          </div>

          <div className="ml-auto flex min-w-0 items-center gap-2 md:gap-3">
            {/* 375 视口只保留「退出」：公司切换 / 打印 / 设置是桌面工作面的动作，
                挤在手机上只会把顶栏撑出横向滚动。 */}
            <div className="hidden md:block">
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
            </div>
            <button
              type="button"
              onClick={() => setPrintOpen(true)}
              className="hidden min-h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-ink-700 hover:border-ink-400 md:inline-flex"
            >
              <span aria-hidden>⎙</span>
              打印
            </button>
            <Link
              href="/settings"
              aria-label="组织与设置（⌘,）"
              className={cn(
                "hidden min-h-9 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm md:inline-flex",
                pathname.startsWith("/settings")
                  ? "bg-indigo-100 text-indigo-600"
                  : "text-ink-700 hover:bg-surface",
              )}
            >
              {name}
              <span className="text-xs text-ink-400">⌘,</span>
            </Link>
            <a
              href="/auth/logout"
              className="hidden whitespace-nowrap text-xs text-ink-400 underline underline-offset-2 md:inline"
            >
              退出
            </a>
            <div ref={moreRef} className="relative md:hidden">
              <button
                ref={moreButtonRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                aria-label="更多入口"
                onClick={() => setMoreOpen((open) => !open)}
                className="inline-flex min-h-9 items-center rounded-md border border-line bg-surface px-2 text-xs text-ink-700 hover:border-ink-400"
              >
                更多
              </button>
              {moreOpen && (
                <div
                  role="menu"
                  aria-label="更多入口"
                  className="absolute right-0 z-40 mt-2 w-56 rounded-lg border border-line bg-surface p-1 shadow-card"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      setPrintOpen(true);
                    }}
                    className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-ink-700 hover:bg-paper"
                  >
                    打印
                  </button>
                  <Link
                    role="menuitem"
                    href="/settings"
                    className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-ink-700 hover:bg-paper"
                  >
                    组织与设置
                  </Link>
                  <a
                    role="menuitem"
                    href="/auth/logout"
                    className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-ink-400 hover:bg-paper"
                  >
                    退出登录
                  </a>
                  {switchableTenants.length > 0 && (
                    <div className="mt-1 border-t border-line pt-1">
                      <p className="px-3 py-1 text-[10px] text-ink-400">
                        切换公司（当前：{tenant.name}）
                      </p>
                      {switchableTenants.map((choice) => (
                        <button
                          key={choice.tenantId}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMoreOpen(false);
                            void switchTenant(choice.tenantId);
                          }}
                          className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-ink-700 hover:bg-paper"
                        >
                          {choice.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
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
        <span>{footerBrandLabel(APP_VERSION, GIT_COMMIT)}</span>
        <span className="mx-2 text-line">·</span>
        {/* 没配支持邮箱时不留一个孤零零的分隔点：改成一句可执行的兜底说明。 */}
        {SUPPORT_EMAIL ? (
          <SupportMailto label="帮助与支持" className="underline underline-offset-2" />
        ) : (
          <span>帮助请联系公司管理员</span>
        )}
      </footer>

      <PrintDrawer open={printOpen} onClose={() => setPrintOpen(false)} />
      {/* 本地 dev 专属：API 有 dev 路由才出现（生产 404 自动隐藏），⌘⇧I 展开 7 个 persona。 */}
      <PersonaBar />
    </div>
  );
}
