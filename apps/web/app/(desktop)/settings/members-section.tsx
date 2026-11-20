"use client";

import { Fragment, useEffect, useState } from "react";
import type { Capability, Currency, DataScope, MemberRole, TeamInvite } from "@weave-order/schema";
import {
  CAPABILITY_ROLES,
  Capability as CapabilityEnum,
  memberRoleLabel,
} from "@weave-order/schema";
import { Badge, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { track } from "@/analytics";
import { formatMoney } from "@weave-order/ui";

const ROLE_OPTIONS: Array<{ value: MemberRole; label: string }> = [
  { value: "OWNER", label: "老板" },
  { value: "MANAGER", label: "主管" },
  { value: "SALES", label: "销售" },
  { value: "MERCHANDISER", label: "跟单" },
  { value: "SAMPLE_ADMIN", label: "样品管理" },
  { value: "FINANCE", label: "财务" },
  { value: "VIEWER", label: "只读" },
];

const SCOPE_OPTIONS: Array<{ value: DataScope; label: string }> = [
  { value: "ALL", label: "全公司" },
  { value: "TEAM", label: "本组" },
  { value: "OWN", label: "本人" },
];

const INVITE_STATUS_LABEL: Record<TeamInvite["status"], string> = {
  INVITED: "待接受",
  ACTIVE: "已加入",
};

/** 成员行怎么称呼：姓名 → 邮箱 → 状态兜底，绝不显示 SSO 主键。 */
function memberLabel(item: TeamInvite): string {
  if (item.isSelf) return "我";
  const name = item.displayName?.trim();
  if (name) return name;
  if (item.email.includes("@")) return item.email;
  return item.status === "INVITED" ? "待接受的邀请" : "已加入的同事";
}

const CAPABILITY_LABEL: Record<Capability, string> = {
  "sample.write": "维护样品",
  "sample.cost.view": "查看成本底线",
  "quote.write": "起草 / 修改报价",
  "quote.approve": "审批报价",
  "quote.confirm": "确认最终价格",
  "quote.workbench.view": "使用报价工作台",
  "quote.price.override": "越过建议价定价",
  "pricing.cross_person.read": "查看他人定价",
  "pricing.policy.edit": "编辑定价策略",
  "pricing.policy.edit.company": "编辑公司级定价策略",
  "member.invite": "邀请 / 管理成员",
  "member.owner.grant": "授予老板角色",
  "settings.edit": "编辑组织设置",
  "resource.merge": "合并客户 / 样品",
  "print.template.publish.html": "发布打印模板",
  "print.execute": "发起打印 / 补打",
  "receivable.read": "查看应收",
  "panorama.orders.view": "查看订单",
  "audit.read.all": "查看全公司日志",
  "audit.read.own": "查看自己的操作",
  "contact.pii.view": "查看联系人手机 / 邮箱",
  "field_options.manage": "管理字段选项",
  "data.import": "导入数据",
  "billing.view": "查看用量与订阅",
};

const MATRIX_ROLES: MemberRole[] = [
  "OWNER",
  "MANAGER",
  "SALES",
  "MERCHANDISER",
  "SAMPLE_ADMIN",
  "FINANCE",
  "VIEWER",
];

/**
 * 成员与权限（设置左栏第二个分栏）。
 *
 * 编辑控件只在 `member.invite` 具备时渲染；真正的拒绝来自服务端能力表，
 * 前端隐藏只减少误触，不是安全边界。
 */
export function MembersSection({
  selfMembershipId,
  canManage,
  canGrantOwner,
  currency,
  role,
}: {
  selfMembershipId: string;
  canManage: boolean;
  canGrantOwner: boolean;
  currency: Currency;
  role: MemberRole;
}) {
  const api = useApi();
  const [members, setMembers] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("SALES");
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<TeamInvite["delivery"]>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<MemberRole>("SALES");
  const [editScope, setEditScope] = useState<DataScope>("OWN");
  const [editLimit, setEditLimit] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listTeam()
      .then((rows) => {
        if (!cancelled) setMembers(rows);
      })
      .catch(() => {
        // 没权限时静默：分栏里的能力矩阵仍然可读。
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 邀请不能直接给 OWNER（契约 `MemberRole.exclude(["OWNER"])`）：老板身份只能
  // 通过「调整已有成员」授予，避免邀请链接被转发后直接拿到最高权限。
  const inviteRoleChoices = ROLE_OPTIONS.filter((option) => option.value !== "OWNER");
  const roleChoices = ROLE_OPTIONS.filter((option) => option.value !== "OWNER" || canGrantOwner);

  async function refresh() {
    const rows = await api.listTeam();
    setMembers(rows);
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      const created = await api.inviteMember({
        email: email.trim(),
        role: inviteRole as Exclude<MemberRole, "OWNER">,
        channel,
        ...(channel === "sms" && phone.trim() ? { phone: phone.trim() } : {}),
      });
      setLink(created.url);
      setDelivery(created.delivery);
      track("invite_created", { role: inviteRole });
      setEmail("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "邀请失败");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(item: TeamInvite) {
    setEditingId(item.membershipId);
    setRowError(null);
    setEditRole(item.role);
    setEditScope(item.dataScope ?? "OWN");
    setEditLimit(
      item.approvalLimitAmount === null || item.approvalLimitAmount === undefined
        ? ""
        : (item.approvalLimitAmount / 100).toFixed(2),
    );
  }

  async function saveEdit(item: TeamInvite) {
    const trimmed = editLimit.trim();
    const limitCents = trimmed === "" ? null : Math.round(Number(trimmed) * 100);
    if (limitCents !== null && (!Number.isFinite(limitCents) || limitCents < 0)) {
      setRowError({ id: item.membershipId, message: "审批额度要填正数金额，或留空表示按角色规则" });
      return;
    }
    setSavingId(item.membershipId);
    setRowError(null);
    try {
      const updated = await api.updateTeamMember(item.membershipId, {
        role: editRole,
        dataScope: editScope,
        approvalLimitAmount: limitCents,
      });
      setMembers((rows) =>
        rows.map((row) => (row.membershipId === updated.membershipId ? updated : row)),
      );
      setEditingId(null);
      setToast(`已更新 ${memberLabel(updated)} 的权限`);
    } catch (cause) {
      setRowError({
        id: item.membershipId,
        message: cause instanceof Error ? cause.message : "保存失败，请稍后重试",
      });
    } finally {
      setSavingId(null);
    }
  }

  async function revoke(item: TeamInvite) {
    setRevokingId(item.membershipId);
    setRowError(null);
    try {
      await api.revokeInvite(item.membershipId);
      setMembers((rows) => rows.filter((row) => row.membershipId !== item.membershipId));
      setToast(`已撤销给 ${item.email} 的邀请，原链接已失效`);
    } catch (cause) {
      setRowError({
        id: item.membershipId,
        message: cause instanceof Error ? cause.message : "撤销失败，请稍后重试",
      });
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="grid gap-6">
      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">成员</h2>
        <p className="mt-1 text-xs text-ink-400">
          至少保留一位老板。调整角色会立即改变对方能看到的菜单与能做的动作；审批额度只影响金额档位。
        </p>
        {toast ? <p className="mt-2 text-xs text-moss-600">{toast}</p> : null}

        {loading ? (
          <p className="mt-3 text-xs text-ink-400">正在读取成员…</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-md border border-line">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-paper text-xs text-ink-400">
                <tr>
                  <th className="px-3 py-2 text-left font-normal">同事</th>
                  <th className="px-3 py-2 text-left font-normal">角色</th>
                  <th className="px-3 py-2 text-left font-normal">数据范围</th>
                  <th className="px-3 py-2 text-left font-normal">审批额度</th>
                  <th className="px-3 py-2 text-left font-normal">状态</th>
                  {canManage ? <th className="px-3 py-2 text-right font-normal">操作</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-ink-700">
                {members.map((item) => {
                  const editing = editingId === item.membershipId;
                  const ownerRow = item.role === "OWNER";
                  const isSelf = item.isSelf === true || item.membershipId === selfMembershipId;
                  const canEditRow = canManage && (!ownerRow || canGrantOwner) && !isSelf;
                  return (
                    <Fragment key={item.membershipId}>
                      <tr>
                        <td className="px-3 py-2">
                          <span className="text-xs">{memberLabel(item)}</span>
                          {item.email ? (
                            <span className="mt-0.5 block text-[11px] text-ink-400">
                              {item.email}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {editing ? (
                            <select
                              value={editRole}
                              onChange={(event) => setEditRole(event.target.value as MemberRole)}
                              className="rounded-md border border-line bg-paper px-2 py-1 text-xs"
                            >
                              {roleChoices.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            memberRoleLabel(item.role)
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {editing ? (
                            <select
                              value={editScope}
                              onChange={(event) => setEditScope(event.target.value as DataScope)}
                              className="rounded-md border border-line bg-paper px-2 py-1 text-xs"
                            >
                              {SCOPE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            (SCOPE_OPTIONS.find((option) => option.value === item.dataScope)
                              ?.label ?? "本人")
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {editing ? (
                            <input
                              inputMode="decimal"
                              value={editLimit}
                              onChange={(event) => setEditLimit(event.target.value)}
                              placeholder="留空 = 按角色规则"
                              className="w-32 rounded-md border border-line bg-paper px-2 py-1 text-xs"
                            />
                          ) : item.approvalLimitAmount === null ||
                            item.approvalLimitAmount === undefined ? (
                            "按角色规则"
                          ) : (
                            formatMoney({ amount: item.approvalLimitAmount, currency })
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <Badge tone={item.status === "ACTIVE" ? "success" : "warning"}>
                            {INVITE_STATUS_LABEL[item.status] ?? "已加入"}
                          </Badge>
                        </td>
                        {canManage ? (
                          <td className="px-3 py-2 text-right text-xs">
                            {editing ? (
                              <span className="inline-flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => void saveEdit(item)}
                                  disabled={savingId === item.membershipId}
                                  className="rounded-md bg-indigo-600 px-2 py-1 text-xs text-white disabled:opacity-60"
                                >
                                  {savingId === item.membershipId ? "保存中…" : "保存"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingId(null)}
                                  className="rounded-md border border-line px-2 py-1 text-xs"
                                >
                                  取消
                                </button>
                              </span>
                            ) : item.status === "INVITED" ? (
                              <button
                                type="button"
                                onClick={() => void revoke(item)}
                                disabled={revokingId === item.membershipId}
                                className="text-vermilion-600 underline underline-offset-2 disabled:opacity-60"
                              >
                                {revokingId === item.membershipId ? "撤销中…" : "撤销邀请"}
                              </button>
                            ) : canEditRow ? (
                              <button
                                type="button"
                                onClick={() => startEdit(item)}
                                className="text-indigo-600 underline underline-offset-2"
                              >
                                编辑
                              </button>
                            ) : (
                              <span className="text-ink-400">—</span>
                            )}
                          </td>
                        ) : null}
                      </tr>
                      {rowError?.id === item.membershipId ? (
                        <tr>
                          <td colSpan={canManage ? 6 : 5} className="bg-vermilion-600/5 px-3 py-2">
                            <p className="text-xs text-vermilion-600">{rowError.message}</p>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canManage ? (
        <section className="rounded-lg border border-line bg-surface px-5 py-4">
          <h2 className="text-sm font-medium text-ink-900">邀请同事</h2>
          <p className="mt-1 text-xs text-ink-400">
            生成一条 7 天有效的专属链接，复制到微信或邮件发给对方；对方登录后点接受即加入。
          </p>
          <form
            onSubmit={(event) => void invite(event)}
            className="mt-3 flex flex-wrap items-end gap-2"
          >
            <label className="grid gap-1 text-[11px] text-ink-400">
              同事邮箱
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="colleague@company.com"
                className="min-w-56 rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900 focus:border-indigo-600 focus:outline-none"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-ink-400">
              角色
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as MemberRole)}
                className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
              >
                {inviteRoleChoices.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-ink-400">
              通知方式
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value as "email" | "sms")}
                className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
              >
                <option value="email">邮件</option>
                <option value="sms">短信</option>
              </select>
            </label>
            {channel === "sms" ? (
              <label className="grid gap-1 text-[11px] text-ink-400">
                手机号
                <input
                  required
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="13800000000"
                  className="min-w-40 rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900"
                />
              </label>
            ) : null}
            <button
              type="submit"
              disabled={
                busy || !email.includes("@") || (channel === "sms" && phone.trim().length < 6)
              }
              className="inline-flex min-h-9 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {busy ? "生成中…" : "生成邀请链接"}
            </button>
          </form>
          {error ? <p className="mt-2 text-xs text-vermilion-600">{error}</p> : null}
          {delivery ? (
            <p className={cn("mt-2 text-xs", delivery.ok ? "text-moss-600" : "text-ink-500")}>
              {delivery.ok
                ? `已通过${delivery.channel === "sms" ? "短信" : "邮件"}发送。也可以复制下面的链接直接发微信。`
                : `没有发出通知（${delivery.detail ?? "发送通道不可用"}）。请复制下面的链接自己发送。`}
            </p>
          ) : null}
          {link ? (
            <div className="mt-3 flex gap-2">
              <input
                readOnly
                value={link}
                onFocus={(event) => event.currentTarget.select()}
                className="flex-1 rounded-md border border-line bg-paper px-3 py-2 font-mono text-xs text-ink-700"
              />
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(link)}
                className="rounded-md border border-line px-3 text-xs text-ink-700 hover:border-ink-400"
              >
                复制
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">能力矩阵（只读）</h2>
        <p className="mt-1 text-xs text-ink-400">
          菜单与按钮的显隐完全由这张表推导；后端 403 用同一份能力表，二者不会漂移。
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="text-ink-400">
              <tr>
                <th className="sticky left-0 bg-surface px-2 py-2 text-left font-normal">能力</th>
                {MATRIX_ROLES.map((item) => (
                  <th key={item} className="px-2 py-2 text-center font-normal">
                    {memberRoleLabel(item)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {CapabilityEnum.options.map((capability) => (
                <tr key={capability}>
                  <td className="sticky left-0 bg-surface px-2 py-1.5 text-ink-700">
                    {CAPABILITY_LABEL[capability]}
                  </td>
                  {MATRIX_ROLES.map((item) => {
                    const allowed = CAPABILITY_ROLES[capability].includes(item);
                    return (
                      <td
                        key={`${capability}-${item}`}
                        className={cn(
                          "px-2 py-1.5 text-center",
                          allowed ? "text-moss-600" : "text-ink-400 opacity-40",
                        )}
                      >
                        {allowed ? "✓" : "·"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-ink-400">当前登录角色：{memberRoleLabel(role)}</p>
      </section>
    </div>
  );
}
