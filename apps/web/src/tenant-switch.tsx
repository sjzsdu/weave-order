"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { MemberRole, TenantChoice } from "@weave-order/schema";
import { Badge, Button, cn } from "@weave-order/ui";

/** 角色中文映射与产品文案表一致；英文枚举不直接出现在界面上。 */
export const ROLE_LABEL: Record<MemberRole, string> = {
  OWNER: "负责人",
  MANAGER: "经理",
  SALES: "销售",
  MERCHANDISER: "跟单",
  SAMPLE_ADMIN: "样品管理",
  FINANCE: "财务",
  VIEWER: "只读",
};

const TENANT_STATUS_LABEL: Record<TenantChoice["tenantStatus"], string | null> = {
  ACTIVE: null,
  TRIAL: "试用",
  SUSPENDED: "已暂停",
  CLOSED: "已关闭",
};

/**
 * 「可见不可进」的原因：优先说成员身份，再说租户状态。
 * 用户需要知道该找谁解决，而不是一个通用 403。
 */
export function unavailableReason(choice: TenantChoice): string | null {
  if (choice.membershipStatus === "DISABLED") return "你在该公司的权限已被停用";
  if (choice.tenantStatus === "CLOSED") return "该公司已经关闭";
  if (choice.tenantStatus === "SUSPENDED") return "该公司已暂停，暂时只能查看";
  if (!choice.available) return "当前不可进入";
  return null;
}

function statusTone(choice: TenantChoice): "danger" | "warning" | "neutral" {
  if (choice.membershipStatus === "DISABLED" || choice.tenantStatus === "CLOSED") return "danger";
  if (choice.tenantStatus === "SUSPENDED" || choice.tenantStatus === "TRIAL") return "warning";
  return "neutral";
}

function statusLabel(choice: TenantChoice): string | null {
  if (choice.membershipStatus === "DISABLED") return "已停用";
  if (choice.tenantStatus === "SUSPENDED") return "已暂停";
  return TENANT_STATUS_LABEL[choice.tenantStatus];
}

function TenantRow({
  choice,
  active,
  disabled,
  onPick,
}: {
  choice: TenantChoice;
  active?: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const reason = unavailableReason(choice);
  const badge = statusLabel(choice);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active === true}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border bg-surface px-4 py-3 text-left",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600/40",
        active ? "border-indigo-600" : "border-line hover:border-ink-400",
        disabled && "cursor-not-allowed opacity-60 hover:border-line",
      )}
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-indigo-100 text-sm font-semibold text-indigo-600"
      >
        {choice.name.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-ink-900">{choice.name}</span>
        <span className="block truncate text-xs text-ink-400">
          {reason ?? choice.brand ?? choice.slug}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {choice.role && <Badge tone="info">{ROLE_LABEL[choice.role]}</Badge>}
        {badge && <Badge tone={statusTone(choice)}>{badge}</Badge>}
        {active && <span className="text-xs text-indigo-600">当前</span>}
      </span>
    </button>
  );
}

/** 键盘语义：上下移动焦点、Enter 进入（listbox 的最小可用实现）。 */
function useArrowList(count: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
    );
    if (options.length === 0) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = options[(index + delta + count) % options.length];
    next?.focus();
  };
  return { ref, onKeyDown };
}

/**
 * 登录后的租户选择页（N>1）。单租户账号永远不会看到它。
 * 记住上次选择只做「当前」标记，不自动跳过：顾问每天第一件事是确认自己在哪家。
 */
export function TenantChooser({
  tenants,
  currentTenantId,
  switching,
  error,
  onSelect,
}: {
  tenants: TenantChoice[];
  currentTenantId?: string | null;
  switching: boolean;
  error?: string | null;
  onSelect: (tenantId: string) => void;
}) {
  const available = tenants.filter((choice) => choice.available);
  const { ref, onKeyDown } = useArrowList(tenants.length);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[480px] flex-col justify-center px-5 py-10">
      <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink-900">选择要进入的公司</h1>
      <p className="mt-2 text-sm text-ink-400">
        你的账号关联了 {tenants.length} 家公司，进入后可随时切换。
      </p>

      {error && (
        <p className="mt-4 rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
          {error}
        </p>
      )}

      <div
        ref={ref}
        role="listbox"
        aria-label="选择公司"
        onKeyDown={onKeyDown}
        className="mt-6 flex flex-col gap-2"
      >
        {tenants.map((choice) => (
          <TenantRow
            key={choice.tenantId}
            choice={choice}
            active={choice.tenantId === currentTenantId}
            disabled={!choice.available || switching}
            onPick={() => onSelect(choice.tenantId)}
          />
        ))}
      </div>

      {switching && (
        <p role="status" aria-live="polite" className="mt-4 text-sm text-ink-400">
          正在进入…
        </p>
      )}
      {available.length === 0 && (
        <p className="mt-4 text-sm text-ink-400">
          你的账号目前没有可进入的公司。请联系管理员恢复权限，或使用另一个账号登录。
        </p>
      )}
    </main>
  );
}

/**
 * 顶栏的「当前公司」切换器。只有一个可用租户时不渲染（产品要求单租户零打扰）。
 * 打开时才拉列表，避免每次进工作台都多打一次目录查询。
 */
export function TenantSwitcher({
  tenants,
  current,
  onSelect,
  onOpenChange,
  openSignal = 0,
}: {
  tenants: TenantChoice[];
  current: { tenantId: string; name: string };
  onSelect: (tenantId: string) => void;
  onOpenChange?: (open: boolean) => void;
  /** 快捷键（⌘⇧O）每触发一次自增，用来从外部打开下拉。 */
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 只暴露可进入的租户 + 当前租户；停用的公司在选择页里说明原因即可。
  const options = tenants.filter(
    (choice) => choice.available || choice.tenantId === current.tenantId,
  );
  if (tenants.filter((choice) => choice.available).length <= 1) {
    return (
      <span className="inline-flex min-h-9 items-center rounded-md px-3 text-sm text-ink-700">
        公司：{current.name}
      </span>
    );
  }

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`切换公司，当前：${current.name}`}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-9 max-w-[220px] items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-ink-700 hover:border-ink-400"
      >
        <span className="truncate">公司：{current.name}</span>
        <span aria-hidden className="text-xs text-ink-400">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="切换公司"
          className="absolute right-0 z-40 mt-2 w-80 rounded-lg border border-line bg-surface p-2 shadow-card"
        >
          {options.map((choice) => (
            <TenantRow
              key={choice.tenantId}
              choice={choice}
              active={choice.tenantId === current.tenantId}
              disabled={!choice.available || choice.tenantId === current.tenantId}
              onPick={() => {
                setOpen(false);
                onSelect(choice.tenantId);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 零租户页：解释 + 可复制的账号 ID，而不是一句裸 403。 */
export function NoMembershipNotice({ subject, message }: { subject?: string; message: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!subject) return;
    try {
      await navigator.clipboard.writeText(subject);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[480px] flex-col justify-center px-5 py-10">
      <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink-900">你的账号还没有加入任何公司</h1>
      <p className="mt-2 text-sm text-ink-400">{message}</p>
      <p className="mt-2 text-sm text-ink-400">
        第一次用就自己创建一间公司，填个名字就能开始；如果是同事邀请你，打开他发你的邀请链接接受即可。
      </p>
      <a
        href="/start"
        className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
      >
        创建公司
      </a>
      <p className="mt-4 text-xs text-ink-400">
        也可以把下面的账号 ID 发给管理员，让对方在公司里邀请你。
      </p>
      {subject && (
        <p className="mt-4 break-all rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs text-ink-700">
          {subject}
        </p>
      )}
      <div className="mt-6 flex gap-3">
        <Button variant="primary" onClick={() => void copy()} disabled={!subject}>
          {copied ? "已复制" : "复制我的账号 ID"}
        </Button>
        <a href="/auth/logout">
          <Button variant="secondary">退出登录</Button>
        </a>
      </div>
    </main>
  );
}
