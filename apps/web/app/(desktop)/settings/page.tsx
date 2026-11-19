"use client";

import { useAuthContext } from "@weave-order/core";
import { Fragment, useEffect, useState } from "react";
import type { TeamInvite } from "@weave-order/schema";
import { memberRoleLabel } from "@weave-order/schema";
import { Badge, EmptyState, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";
import { SupportMailto } from "@/support";
import { useMounted } from "@/use-mounted";
import { track } from "@/analytics";
import { formatMoney } from "@weave-order/ui";
import { FieldOptionsSummary } from "@/field-options-manager";

const INVITE_STATUS_LABEL: Record<TeamInvite["status"], string> = {
  INVITED: "待接受",
  ACTIVE: "已加入",
};

/**
 * 成员姓名：`name` 为空时退到邮箱，再退到「我」。
 * 绝不回退到 `subject` —— 那是 SSO 主键 UUID，给用户看只会破坏信任。
 */
function memberDisplayName(me: { name: string | null; email: string | null }): string {
  return me.name?.trim() || me.email?.trim() || "我";
}

/** 成员表里的一行怎么称呼：绝不把 SSO 主键或原始枚举放到界面上。 */
function memberRowLabel(item: TeamInvite, selfMembershipId: string): string {
  if (item.membershipId === selfMembershipId) return "我";
  if (item.email.includes("@")) return item.email;
  return item.status === "INVITED" ? "待接受的邀请" : "已加入的同事";
}

const SCOPE_LABEL: Record<string, string> = {
  ALL: "全公司",
  TEAM: "本组",
  OWN: "本人",
};

const STATUS_LABEL: Record<string, string> = {
  TRIAL: "试用中",
  ACTIVE: "正常使用",
  OVERDUE: "已逾期",
  SUSPENDED: "已暂停",
  CANCELLED: "已停用",
};

const ISOLATION_LABEL: Record<string, string> = {
  SHARED_RLS: "共享库 · 按公司隔离",
  SCHEMA: "独立 schema",
  DATABASE: "独立数据库",
};

const CURRENCY_LABEL: Record<string, string> = {
  CNY: "人民币（CNY）",
  USD: "美元（USD）",
  EUR: "欧元（EUR）",
  HKD: "港币（HKD）",
};

function Field({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="border-b border-line py-3 last:border-b-0">
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink-900">{value}</dd>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

/** 组织设置（⌘,）：管理面，不是第四个业务窗口。 */
export default function SettingsPage() {
  const mounted = useMounted();
  if (!mounted) {
    return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  }
  return <SettingsPageContent />;
}

function SettingsPageContent() {
  const api = useApi();
  const me = useAuthContext(api);

  if (me.isLoading) return <Spinner label="读取组织信息…" />;
  if (me.isError || !me.data) {
    return (
      <EmptyState
        title="组织信息读取失败"
        description={
          me.error instanceof Error
            ? me.error.message
            : "刷新页面重试一次；仍然不行就联系公司管理员。"
        }
        actions={
          <SupportMailto
            className="text-sm text-indigo-600 underline underline-offset-2"
            label="写信给我们"
          />
        }
      />
    );
  }

  // 还没选租户时没有组织信息可展示；外壳会渲染选择页，这里只做兜底。
  if ("tenants" in me.data) {
    return (
      <EmptyState
        title="请先选择公司"
        description="选择要进入的公司后，这里会显示该公司的组织资料。"
      />
    );
  }

  const { tenant, membership } = me.data;
  const limit = membership.approvalLimitAmount;

  return (
    <div className="grid gap-6">
      <header>
        <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">组织与设置</p>
        <h1 className="mt-1 text-2xl font-semibold text-ink-900">{tenant.name}</h1>
        <p className="mt-1 text-sm text-ink-400">
          这里能看到公司资料、你的角色和审批权限。资料由平台管理员维护，需要修改时找管理员即可。
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface px-5 py-3">
          <h2 className="py-2 text-sm font-medium text-ink-900">组织资料</h2>
          <dl>
            <Field label="组织名称" value={tenant.name} />
            <Field label="品牌抬头" value={tenant.brand ?? "—"} hint="用于报价页与打印单证抬头" />
            <Field
              label="公司标识"
              value={<code className="font-mono text-xs">{tenant.slug}</code>}
              hint="和我们的技术支持沟通时提供这一串即可"
            />
            <Field
              label="计费币种"
              value={CURRENCY_LABEL[tenant.currency] ?? tenant.currency}
              hint="报价、订单与账单都按这个币种计算"
            />
            <Field
              label="状态"
              value={
                <span className="flex items-center gap-2">
                  <Badge tone={tenant.status === "ACTIVE" ? "success" : "warning"}>
                    {STATUS_LABEL[tenant.status] ?? "状态未知"}
                  </Badge>
                  <span className="text-xs text-ink-400">
                    {ISOLATION_LABEL[tenant.isolationMode] ?? "按公司隔离"}
                  </span>
                </span>
              }
            />
          </dl>
        </section>

        <section className="rounded-lg border border-line bg-surface px-5 py-3">
          <h2 className="py-2 text-sm font-medium text-ink-900">我的角色与数据范围</h2>
          <dl>
            <Field
              label="成员"
              value={memberDisplayName(me.data)}
              hint={me.data.name?.trim() && me.data.email ? me.data.email : undefined}
            />
            <Field label="角色" value={memberRoleLabel(membership.role)} />
            <Field label="数据范围" value={SCOPE_LABEL[membership.dataScope] ?? "本人"} />
            <Field
              label="审批上限"
              value={
                limit === null
                  ? "不限（按角色规则）"
                  : formatMoney({ amount: limit, currency: tenant.currency })
              }
              hint="超过上限的金额会自动升级给上级审批"
            />
            <Field
              label="登录方式"
              value="公司统一账号"
              hint="不保存密码；忘记密码在统一登录页重置"
            />
          </dl>
        </section>
      </div>

      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">角色与审批等级</h2>
        <p className="mt-1 text-xs text-ink-400">
          金额类动作一律先出草稿、由人确认；超过上限或改幅超过阈值时，自动升级给上级审批，不需要你手动报备。
        </p>
        <div className="mt-3 overflow-hidden rounded-md border border-line">
          <table className="w-full text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-normal">角色</th>
                <th className="px-3 py-2 text-left font-normal">典型职责</th>
                <th className="px-3 py-2 text-left font-normal">审批边界</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-ink-700">
              <tr>
                <td className="px-3 py-2">老板 / 主管</td>
                <td className="px-3 py-2">定价策略、大额审批</td>
                <td className="px-3 py-2">可批全部；大额双人复核</td>
              </tr>
              <tr>
                <td className="px-3 py-2">销售 / 跟单</td>
                <td className="px-3 py-2">出报价、跟进客户</td>
                <td className="px-3 py-2">本人数据；超限升级</td>
              </tr>
              <tr>
                <td className="px-3 py-2">财务</td>
                <td className="px-3 py-2">对账、收款确认</td>
                <td className="px-3 py-2">只读业务 + 财务确认</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface px-5 py-4">
          <h2 className="text-sm font-medium text-ink-900">登录与安全</h2>
          <dl>
            <Field label="身份提供方" value="公司统一账号（单点登录）" />
            <Field
              label="账号归属"
              value="一个公司一个独立空间"
              hint="不会看到其他公司的任何数据"
            />
            <Field label="会话" value="登录一次即可使用" hint="换电脑或清空浏览器后需要重新登录" />
          </dl>
        </section>

        <section className="rounded-lg border border-line bg-surface px-5 py-4">
          <h2 className="text-sm font-medium text-ink-900">日常使用</h2>
          <dl>
            <Field label="窗口" value="工作台 ⌘1 · 审批 ⌘2 · 全景 ⌘3" />
            <Field label="设置" value="组织与设置 ⌘," />
            <Field label="打印" value="任意页面调用打印面板，桌面版直连打印机" />
            <Field label="外设" value="扫码枪、电子秤、标签机即插即用" />
          </dl>
        </section>
      </div>

      <FieldOptionsSummary />

      <CreditsCard />

      <TeamSection
        canManage={me.data.capabilities.includes("member.invite")}
        selfMembershipId={membership.id}
      />

      <p className="text-xs text-ink-400">
        公司资料由平台管理员维护；成员邀请可以在这里随时撤销。需要改公司名、抬头或增加账号数，
        <SupportMailto
          className="text-indigo-600 underline underline-offset-2"
          label="写信给我们"
        />{" "}
        或联系你的对接人。
      </p>
    </div>
  );
}

const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "MANAGER", label: "主管" },
  { value: "SALES", label: "销售" },
  { value: "MERCHANDISER", label: "跟单" },
  { value: "SAMPLE_ADMIN", label: "样品管理" },
  { value: "FINANCE", label: "财务" },
  { value: "VIEWER", label: "只读" },
];

/**
 * 邀请同事（老板/主管可用）。
 *
 * 生成一条 7 天有效的专属链接，复制到微信或邮件发给对方；对方登录后点接受即加入。
 * 没有接短信/邮件服务，所以这里负责生成与复制，不做「已发送」的假象。
 */
function TeamSection({
  canManage,
  selfMembershipId,
}: {
  canManage: boolean;
  selfMembershipId: string;
}) {
  const api = useApi();
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("SALES");
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<TeamInvite["delivery"]>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<{
    membershipId: string;
    message: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    api
      .listTeam()
      .then((rows) => {
        if (!cancelled) setInvites(rows);
      })
      .catch(() => {
        // 没有权限时静默：设置页其它部分仍然可读。
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      const created = await api.inviteMember({
        email: email.trim(),
        role: role as never,
        channel,
        ...(channel === "sms" && phone.trim() ? { phone: phone.trim() } : {}),
      });
      setLink(created.url);
      // 只记角色，不记同事的邮箱和手机号。
      track("invite_created", { role });
      setDelivery(created.delivery);
      setEmail("");
      const rows = await api.listTeam();
      setInvites(rows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "邀请失败");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      setError("复制失败，请手动选中链接复制");
    }
  }

  async function revoke(item: TeamInvite) {
    setRevokingId(item.membershipId);
    setRevokeError(null);
    try {
      await api.revokeInvite(item.membershipId);
      setInvites((rows) => rows.filter((row) => row.membershipId !== item.membershipId));
      setConfirmingId(null);
      setToast(`已撤销给 ${item.email} 的邀请，原链接已失效`);
    } catch (cause) {
      // 服务端已经给出人话原因（403 / 404 / 409）；没有就用通用文案，不假装成功。
      setRevokeError({
        membershipId: item.membershipId,
        message: cause instanceof Error ? cause.message : "撤销失败，请稍后重试",
      });
      setConfirmingId(null);
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-sm font-medium text-ink-900">邀请同事</h2>
      <p className="mt-1 text-xs text-ink-400">
        填同事邮箱和角色，生成一条 7
        天有效的专属链接，复制到微信或邮件发给他。他打开链接、登录后点「接受邀请」就加入你这间公司。
      </p>

      <form
        onSubmit={(event) => void submit(event)}
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
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900 focus:border-indigo-600 focus:outline-none"
          >
            {ROLE_OPTIONS.map((option) => (
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
            className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900 focus:border-indigo-600 focus:outline-none"
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
              className="min-w-40 rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-900 focus:border-indigo-600 focus:outline-none"
            />
          </label>
        ) : null}
        <button
          type="submit"
          disabled={busy || !email.includes("@") || (channel === "sms" && phone.trim().length < 6)}
          className="inline-flex min-h-9 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {busy ? "生成中…" : "生成邀请链接"}
        </button>
      </form>

      {error ? <p className="mt-2 text-xs text-vermilion-600">{error}</p> : null}

      {delivery ? (
        <p className={`mt-2 text-xs ${delivery.ok ? "text-moss-600" : "text-ink-500"}`}>
          {delivery.ok
            ? `已通过${delivery.channel === "sms" ? "短信" : "邮件"}发送给 ${email || "对方"}。也可以复制下面的链接直接发微信。`
            : `没有发出通知（${delivery.detail ?? "发送通道不可用"}）。请复制下面的链接，自己发给对方。`}
        </p>
      ) : null}

      {link ? (
        <div className="mt-3 grid gap-2">
          <p className="text-xs text-ink-500">这条链接 7 天有效：</p>
          <div className="flex gap-2">
            <input
              readOnly
              value={link}
              onFocus={(event) => event.currentTarget.select()}
              className="flex-1 rounded-md border border-line bg-paper px-3 py-2 font-mono text-xs text-ink-700"
            />
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-md border border-line px-3 text-xs text-ink-700 hover:border-ink-400"
            >
              复制
            </button>
          </div>
        </div>
      ) : null}

      {invites.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-md border border-line">
          <table className="w-full text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-normal">同事</th>
                <th className="hidden px-3 py-2 text-left font-normal sm:table-cell">角色</th>
                <th className="hidden px-3 py-2 text-left font-normal sm:table-cell">状态</th>
                {canManage ? <th className="px-3 py-2 text-right font-normal">操作</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-ink-700">
              {invites.map((item) => (
                <Fragment key={item.membershipId}>
                  <tr>
                    <td className="px-3 py-2 text-xs">
                      {memberRowLabel(item, selfMembershipId)}
                      <span className="mt-0.5 block text-ink-400 sm:hidden">
                        {memberRoleLabel(item.role)} ·{" "}
                        {INVITE_STATUS_LABEL[item.status] ?? "已加入"}
                      </span>
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs sm:table-cell">
                      {memberRoleLabel(item.role)}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-ink-400 sm:table-cell">
                      {INVITE_STATUS_LABEL[item.status] ?? "已加入"}
                    </td>
                    {canManage ? (
                      <td className="px-3 py-2 text-right text-xs">
                        {item.status === "INVITED" ? (
                          confirmingId === item.membershipId ? (
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <span className="text-ink-500">
                                撤销后这条邀请链接立即失效，对方将无法再通过它加入。
                              </span>
                              <button
                                type="button"
                                disabled={revokingId === item.membershipId}
                                onClick={() => void revoke(item)}
                                className="rounded-md bg-vermilion-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-vermilion-600/90 disabled:opacity-60"
                              >
                                {revokingId === item.membershipId ? "撤销中…" : "确认撤销"}
                              </button>
                              <button
                                type="button"
                                disabled={revokingId === item.membershipId}
                                onClick={() => setConfirmingId(null)}
                                className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-700 hover:border-ink-400 disabled:opacity-60"
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmingId(item.membershipId);
                                setRevokeError(null);
                              }}
                              className="whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-xs text-ink-700 hover:border-vermilion-600 hover:text-vermilion-600"
                            >
                              撤销
                            </button>
                          )
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                  {revokeError?.membershipId === item.membershipId ? (
                    <tr>
                      <td
                        colSpan={canManage ? 4 : 3}
                        className="bg-vermilion-100 px-3 py-2 text-xs text-vermilion-600"
                      >
                        撤销失败：{revokeError.message}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {toast ? (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-50 rounded-md bg-ink-900 px-4 py-2 text-sm text-white shadow-lg"
        >
          {toast}
        </div>
      ) : null}
    </section>
  );
}

type CreditsState = {
  period: string;
  creditsIncluded: number | null;
  creditsUsed: number;
  percent: number;
  state: "OK" | "WARN" | "PAUSED";
};

/**
 * 本月 credits：套餐含的额度 + 已用 + 超额提醒。
 * 到 80% 提示、到 100% 智能体暂停（人仍可查看、审批、导出），充值后恢复。
 */
function CreditsCard() {
  const api = useApi();
  const [data, setData] = useState<CreditsState | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .creditsUsage()
      .then((usage) => {
        if (!cancelled) setData(usage);
      })
      .catch(() => {
        // 拿不到就隐藏，不影响设置页其它内容。
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!data) return null;

  const percent = Math.max(0, Math.min(100, data.percent));
  const tone =
    data.state === "PAUSED"
      ? "bg-vermilion-600"
      : data.state === "WARN"
        ? "bg-amber-500"
        : "bg-indigo-600";

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium text-ink-900">本月 AI 额度（credits）</h2>
        <span className="font-mono text-xs text-ink-400">{data.period}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold text-ink-900">
        {data.creditsUsed.toLocaleString()}
        <span className="ml-1 text-sm font-normal text-ink-400">
          / {data.creditsIncluded === null ? "不限" : data.creditsIncluded.toLocaleString()} credits
        </span>
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-paper">
        <div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 text-xs text-ink-500">
        {data.state === "PAUSED"
          ? "额度已用完：智能体暂停，你仍可以查看、审批和导出；充值或升级后立刻恢复。"
          : data.state === "WARN"
            ? "已用超过 80%：接下来智能体会变慢或暂停，建议提前充值或升级套餐。"
            : "1 credit ≈ 1,000 tokens。额度每月 1 日重置，不结转。"}
      </p>
    </section>
  );
}
