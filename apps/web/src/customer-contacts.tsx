"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, useAuthContext } from "@weave-order/core";
import type { ContactWarning, CustomerContact } from "@weave-order/schema";
import { Badge, Button, cn } from "@weave-order/ui";
import { useApi } from "@/providers";

/**
 * 客户 360 的联系人卡片 + 编辑抽屉（WAN-177）。
 *
 * 三条产品规则直接体现在交互里：
 * - 主要联系人只有一个，换主是独立动作，不需要先归档；
 * - 归档主要联系人必须先选继任者，防止客户突然「没有联系人」；
 * - VIEWER（无 contact.pii.view）看到掩码手机/邮箱，也没有编辑入口，
 *   避免把 `138****8000` 当成真实值回写。
 */
export function CustomerContactsSection({
  customerId,
  contacts,
  onChanged,
}: {
  customerId: string;
  contacts: CustomerContact[];
  onChanged: () => Promise<unknown> | void;
}) {
  const api = useApi();
  const me = useAuthContext(api);
  const queryClient = useQueryClient();
  const capabilities = me.data && !("tenants" in me.data) ? me.data.capabilities : [];
  const canEdit = capabilities.includes("contact.pii.view");
  const [editing, setEditing] = useState<CustomerContact | "new" | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<CustomerContact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<ContactWarning[]>([]);
  // 折叠摘要：默认只展示前 3 位，客户联系人多的不把 360 首屏撑长。
  const [expanded, setExpanded] = useState(false);

  const primary = contacts.find((contact) => contact.isPrimary) ?? contacts[0] ?? null;

  async function refresh() {
    await Promise.all([
      onChanged(),
      queryClient.invalidateQueries({ queryKey: ["customers"] }),
    ]);
  }

  async function setPrimary(contact: CustomerContact) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      await api.setPrimaryCustomerContact(customerId, contact.id);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function archive(contact: CustomerContact, successorContactId?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.archiveCustomerContact(customerId, contact.id, {
        ...(successorContactId ? { successorContactId } : {}),
      });
      setArchiveTarget(null);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-ink-700">联系人</h2>
          <p className="mt-0.5 text-xs text-ink-400">
            {contacts.length === 0
              ? "还没有联系人，先补一位主要联系人。"
              : `${contacts.length} 位联系人 · 主要联系人 ${primary?.name ?? "—"}`}
          </p>
        </div>
        {canEdit && (
          <Button className="min-h-8 px-3 text-xs" onClick={() => setEditing("new")}>
            新增联系人
          </Button>
        )}
      </div>

      {warnings.length > 0 && (
        <div
          role="status"
          className="mt-3 rounded-md border border-amber-500/40 bg-amber-100/50 px-3 py-2 text-xs text-ink-700"
        >
          {warnings.map((warning) => (
            <p key={`${warning.customerId}-${warning.message}`}>{warning.message}</p>
          ))}
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600"
        >
          {error}
        </p>
      )}

      {contacts.length === 0 ? (
        <p className="mt-3 text-sm text-ink-400">新增联系人才会显示在这里。</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {(expanded ? contacts : contacts.slice(0, 3)).map((contact) => (
            <li
              key={contact.id}
              className={cn(
                "rounded-md border px-3 py-2",
                contact.isPrimary ? "border-indigo-600/40 bg-indigo-100/20" : "border-line",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink-900">{contact.name}</span>
                {contact.isPrimary && <Badge tone="info">主要</Badge>}
                {contact.role && <span className="text-xs text-ink-400">{contact.role}</span>}
                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  {canEdit && !contact.isPrimary && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void setPrimary(contact)}
                      className="text-xs text-indigo-600 underline underline-offset-2 disabled:opacity-50"
                    >
                      设为主要
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setEditing(contact)}
                      className="text-xs text-ink-700 underline underline-offset-2 disabled:opacity-50"
                    >
                      编辑
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setArchiveTarget(contact)}
                      className="text-xs text-vermilion-600 underline underline-offset-2 disabled:opacity-50"
                    >
                      归档
                    </button>
                  )}
                </span>
              </div>
              <div className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-ink-700 sm:grid-cols-2">
                <span>手机 {contact.phone ?? "—"}</span>
                <span>邮箱 {contact.email ?? "—"}</span>
                <span>微信 {contact.wechat ?? "—"}</span>
                {contact.note && <span className="sm:col-span-2">备注 {contact.note}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {contacts.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-2 text-xs text-indigo-600 underline underline-offset-2"
        >
          {expanded ? "收起" : `展开全部 ${contacts.length} 位联系人`}
        </button>
      )}

      {editing && (
        <ContactEditor
          customerId={customerId}
          contact={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (result) => {
            setEditing(null);
            setWarnings(result.warnings);
            await refresh();
          }}
        />
      )}

      {archiveTarget && (
        <ArchiveDialog
          contact={archiveTarget}
          candidates={contacts.filter((contact) => contact.id !== archiveTarget.id)}
          busy={busy}
          error={error}
          onCancel={() => {
            setArchiveTarget(null);
            setError(null);
          }}
          onConfirm={(successorContactId) => void archive(archiveTarget, successorContactId)}
        />
      )}
    </section>
  );
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error && cause.message) return cause.message;
  return "保存失败，请稍后重试";
}

const FIELD_CLASS =
  "min-h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink-900 outline-none focus:border-indigo-600";

function ContactEditor({
  customerId,
  contact,
  onClose,
  onSaved,
}: {
  customerId: string;
  contact: CustomerContact | null;
  onClose: () => void;
  onSaved: (result: { warnings: ContactWarning[] }) => Promise<void> | void;
}) {
  const api = useApi();
  const [name, setName] = useState(contact?.name ?? "");
  const [role, setRole] = useState(contact?.role ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [wechat, setWechat] = useState(contact?.wechat ?? "");
  const [note, setNote] = useState(contact?.note ?? "");
  const [isPrimary, setIsPrimary] = useState(contact?.isPrimary ?? false);
  const [roles, setRoles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .contactRoles()
      .then((result) => {
        if (!cancelled) setRoles(result.roles.map((item) => item.label));
      })
      .catch(() => {
        // 选项加载失败不影响手输：角色本来就是自由文本，只少了建议。
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const title = contact ? "编辑联系人" : "新增联系人";

  async function submit() {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("联系人姓名必填");
      return;
    }
    setBusy(true);
    setError(null);
    const payload = {
      name: trimmed,
      role: role.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      wechat: wechat.trim() || null,
      note: note.trim() || null,
      isPrimary,
    };
    try {
      const result = contact
        ? await api.updateCustomerContact(customerId, contact.id, payload)
        : await api.createCustomerContact(customerId, payload);
      await onSaved({ warnings: result.warnings });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex justify-end bg-ink-900/30"
      onClick={onClose}
    >
      <form
        className="flex h-full w-full max-w-[460px] flex-col overflow-y-auto bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-base font-semibold text-ink-900">{title}</h3>
          <Button
            variant="ghost"
            className="min-h-9 px-3 text-xs"
            onClick={onClose}
            disabled={busy}
          >
            关闭
          </Button>
        </header>
        <div className="grid gap-4 px-5 py-5">
          {error && (
            <p
              role="alert"
              className="rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600"
            >
              {error}
            </p>
          )}
          <label className="grid gap-1 text-xs text-ink-400">
            姓名（必填）
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={FIELD_CLASS}
              placeholder="例如 周敏"
            />
          </label>
          <label className="grid gap-1 text-xs text-ink-400">
            角色
            <input
              list="contact-role-options"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              className={FIELD_CLASS}
              placeholder="采购 / 财务 / 跟单，或自定义"
            />
            <datalist id="contact-role-options">
              {roles.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-xs text-ink-400">
              手机
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                className={FIELD_CLASS}
                inputMode="tel"
              />
            </label>
            <label className="grid gap-1 text-xs text-ink-400">
              微信
              <input
                value={wechat}
                onChange={(event) => setWechat(event.target.value)}
                className={FIELD_CLASS}
              />
            </label>
          </div>
          <label className="grid gap-1 text-xs text-ink-400">
            邮箱
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>
          <label className="grid gap-1 text-xs text-ink-400">
            备注
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className={cn(FIELD_CLASS, "min-h-20 py-2")}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(event) => setIsPrimary(event.target.checked)}
              disabled={contact?.isPrimary}
              className="h-4 w-4"
            />
            设为主要联系人
            {contact?.isPrimary && (
              <span className="text-xs text-ink-400">（要换主请用列表里的「设为主要」）</span>
            )}
          </label>
        </div>
        <footer className="mt-auto flex justify-end gap-2 border-t border-line px-5 py-4">
          <Button className="min-h-9 px-3 text-xs" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            className="min-h-9 px-3 text-xs"
            type="submit"
            disabled={busy}
          >
            {busy ? "保存中…" : "保存"}
          </Button>
        </footer>
      </form>
    </div>
  );
}

function ArchiveDialog({
  contact,
  candidates,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  contact: CustomerContact;
  candidates: CustomerContact[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (successorContactId?: string) => void;
}) {
  const [successorId, setSuccessorId] = useState(candidates[0]?.id ?? "");
  const needsSuccessor = contact.isPrimary;
  const canConfirm = !needsSuccessor || successorId !== "";
  const explanation = useMemo(
    () =>
      needsSuccessor
        ? "这是主要联系人。归档前必须选一位继任者，他会同时成为新的主要联系人。"
        : "归档后联系人不再出现在列表和下拉里，历史外发记录仍保留快照。",
    [needsSuccessor],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="归档联系人"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[420px] rounded-lg border border-line bg-surface p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-ink-900">归档「{contact.name}」</h3>
        <p className="mt-2 text-sm text-ink-700">{explanation}</p>
        {needsSuccessor && (
          <label className="mt-3 grid gap-1 text-xs text-ink-400">
            继任的主要联系人
            <select
              value={successorId}
              onChange={(event) => setSuccessorId(event.target.value)}
              className={FIELD_CLASS}
            >
              {candidates.length === 0 && <option value="">没有其他联系人可选</option>}
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                  {candidate.role ? ` · ${candidate.role}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="mt-3 text-sm text-vermilion-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button className="min-h-9 px-3 text-xs" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            className="min-h-9 px-3 text-xs"
            disabled={busy || !canConfirm}
            onClick={() => onConfirm(needsSuccessor ? successorId : undefined)}
          >
            {busy ? "归档中…" : "确认归档"}
          </Button>
        </div>
      </div>
    </div>
  );
}
