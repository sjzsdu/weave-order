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
            : "刷新页面重试一次；仍然不行就联系公司管理员或写信到 hello@weaveorder.cn"
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
              label="租户标识"
              value={<code className="font-mono text-xs">{tenant.id}</code>}
              hint="平台分配的公司编号，和我们的技术支持沟通时提供这一串即可"
            />
            <Field
              label="计费币种"
              value={tenant.currency}
              hint="报价、订单与账单都按这个币种计算"
            />
            <Field
              label="状态"
              value={
                <span className="flex items-center gap-2">
                  <Badge tone={tenant.status === "ACTIVE" ? "success" : "warning"}>
                    {STATUS_LABEL[tenant.status] ?? tenant.status}
                  </Badge>
                  <span className="text-xs text-ink-400">
                    {ISOLATION_LABEL[tenant.isolationMode] ?? tenant.isolationMode}
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
              value={me.data.name ?? me.data.subject}
              hint={me.data.email ?? undefined}
            />
            <Field label="角色" value={ROLE_LABEL[membership.role] ?? membership.role} />
            <Field
              label="数据范围"
              value={SCOPE_LABEL[membership.dataScope] ?? membership.dataScope}
            />
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

      <p className="text-xs text-ink-400">
        公司资料与成员由平台管理员维护，本页只读。需要改公司名、抬头或增加席位，写信到
        hello@weaveorder.cn 或联系你的对接人。
      </p>
    </div>
  );
}
