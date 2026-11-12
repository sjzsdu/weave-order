"use client";

import { useAuthContext } from "@weave-order/core";
import { Badge, EmptyState, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMounted } from "@/use-mounted";
import { formatMoney } from "@weave-order/ui";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "老板 / Owner",
  MANAGER: "主管 / Manager",
  SALES: "销售 / Sales",
  MERCHANDISER: "跟单 / Merchandiser",
  SAMPLE_ADMIN: "样品管理",
  FINANCE: "财务 / Finance",
  VIEWER: "只读",
};

const SCOPE_LABEL: Record<string, string> = {
  ALL: "全公司",
  TEAM: "本组",
  OWN: "本人",
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
        description={me.error instanceof Error ? me.error.message : "请确认后端与登录状态"}
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
          管理面只此一份。业务数据与设置都在后端校验，前端只读展示。
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface px-5 py-3">
          <h2 className="py-2 text-sm font-medium text-ink-900">组织资料</h2>
          <dl>
            <Field label="组织名称" value={tenant.name} />
            <Field label="品牌抬头" value={tenant.brand ?? "—"} hint="用于报价页与打印单证抬头" />
            <Field
              label="租户标识"
              value={<code className="font-mono text-xs">{tenant.id}</code>}
              hint="前端永不传 tenant_id；网关按登录身份注入"
            />
            <Field
              label="计费币种"
              value={tenant.currency}
              hint="金额一律整数分，由内核计算"
            />
            <Field
              label="状态"
              value={
                <span className="flex items-center gap-2">
                  <Badge tone={tenant.status === "ACTIVE" ? "success" : "warning"}>{tenant.status}</Badge>
                  <span className="text-xs text-ink-400">{tenant.isolationMode}</span>
                </span>
              }
            />
          </dl>
        </section>

        <section className="rounded-lg border border-line bg-surface px-5 py-3">
          <h2 className="py-2 text-sm font-medium text-ink-900">我的角色与数据范围</h2>
          <dl>
            <Field label="成员" value={me.data.name ?? me.data.subject} hint={me.data.email ?? undefined} />
            <Field label="角色" value={ROLE_LABEL[membership.role] ?? membership.role} />
            <Field label="数据范围" value={SCOPE_LABEL[membership.dataScope] ?? membership.dataScope} />
            <Field
              label="审批上限"
              value={limit === null ? "不限（按角色兜底）" : formatMoney({ amount: limit, currency: tenant.currency })}
              hint="超过上限的金额会自动升级审批；阈值判断永远在后端"
            />
            <Field label="登录方式" value="Casdoor OIDC" hint="本地只保留角色映射，不存密码" />
          </dl>
        </section>
      </div>

      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">角色与审批等级</h2>
        <p className="mt-1 text-xs text-ink-400">
          L1 记录建议 → L2 人类确认（默认）→ L3 双人复核。金额类动作永不低于 L2。
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
            <Field label="身份提供方" value="Casdoor（自托管）" />
            <Field label="回调地址" value={<code className="font-mono text-xs">/auth/callback</code>} />
            <Field label="会话" value="OIDC Authorization Code + PKCE" hint="一个租户一个 Casdoor Organization" />
          </dl>
        </section>

        <section className="rounded-lg border border-line bg-surface px-5 py-4">
          <h2 className="text-sm font-medium text-ink-900">桌面能力</h2>
          <dl>
            <Field label="窗口" value="工作台 ⌘1 · 审批 ⌘2 · 全景 ⌘3" />
            <Field label="管理面" value="组织与设置 ⌘," />
            <Field label="打印" value="全局抽屉（非第四个窗口），P1 接打印代理" />
            <Field label="外设桥" value="Tauri 壳仅暴露 print / scan / readFile / 电子秤，P3" />
          </dl>
        </section>
      </div>

      <p className="text-xs text-ink-400">
        组织资料与成员管理由平台控制面（Track F）维护；本页只读，避免前端绕过内核写业务配置。
      </p>
    </div>
  );
}
