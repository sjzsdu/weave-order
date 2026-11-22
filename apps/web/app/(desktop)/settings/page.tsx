"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthContext } from "@weave-order/core";
import type { Capability, Currency, MemberRole, WeightUnit, WidthUnit } from "@weave-order/schema";
import {
  SETTINGS_SECTIONS,
  WEIGHT_UNITS,
  WEIGHT_UNIT_LABEL,
  WIDTH_UNITS,
  WIDTH_UNIT_LABEL,
  memberRoleLabel,
  visibleNav,
} from "@weave-order/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, EmptyState, Spinner, cn } from "@weave-order/ui";
import { formatMoney } from "@weave-order/ui";
import { useApi } from "@/providers";
import { SUPPORT_EMAIL, SupportMailto } from "@/support";
import { useMounted } from "@/use-mounted";
import { FieldOptionsSummary } from "@/field-options-manager";
import { AuditLogView } from "@/audit-log";
import { useWorkspaceIA } from "@/workspace-ia";
import { useMeasureUnits } from "@/measure-units";
import { CodeRulesSection } from "./code-rules-section";
import { MembersSection } from "./members-section";

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

/** 成员姓名：`name` 为空时退到邮箱，再退到「我」；绝不回退到 SSO 主键。 */
function memberDisplayName(me: { name: string | null; email: string | null }): string {
  return me.name?.trim() || me.email?.trim() || "我";
}

/**
 * 设置（⌘,）：管理面，不是业务窗口。
 *
 * 左栏六个分栏由 `SETTINGS_SECTIONS` + 能力集合投影而来；分栏选中态写进
 * `?section=`，因此「把某条设置发给同事」是一条可分享的深链。
 */
export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-400">正在连接织序…</div>}>
      <SettingsShell />
    </Suspense>
  );
}

function SettingsShell() {
  const mounted = useMounted();
  if (!mounted) {
    return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  }
  return <SettingsContent />;
}

function SettingsContent() {
  const api = useApi();
  const router = useRouter();
  const params = useSearchParams();
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
  if ("tenants" in me.data) {
    return (
      <EmptyState
        title="请先选择公司"
        description="选择要进入的公司后，这里会显示该公司的组织资料。"
      />
    );
  }

  const { tenant, membership, capabilities } = me.data;
  const sections = visibleNav(SETTINGS_SECTIONS, capabilities);
  if (sections.length === 0) {
    return (
      <EmptyState
        title="没有可管理的设置"
        description="当前角色没有可查看的设置分栏；需要调整请联系公司管理员。"
      />
    );
  }
  const requested = params.get("section");
  const active = sections.find((item) => sectionKey(item.href) === requested) ?? sections[0]!;

  const go = (href: string) => {
    router.replace(href, { scroll: false });
  };

  return (
    <div className="grid gap-6">
      <header>
        <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">组织与设置</p>
        <h1 className="mt-1 text-2xl font-semibold text-ink-900">{tenant.name}</h1>
        <p className="mt-1 text-sm text-ink-400">
          共 {sections.length}{" "}
          个分栏可见。资料由平台管理员维护；成员角色、数据范围与审批额度可在这里调整。
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="md:sticky md:top-20 md:self-start">
          <nav aria-label="设置分栏" className="flex gap-1 overflow-x-auto md:flex-col">
            {sections.map((item) => {
              const selected = item.href === active.href;
              return (
                <button
                  key={item.href}
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  onClick={() => go(item.href)}
                  className={cn(
                    "shrink-0 rounded-md px-3 py-2 text-left text-sm",
                    selected
                      ? "bg-indigo-100 font-medium text-indigo-600"
                      : "text-ink-700 hover:bg-surface",
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="min-w-0">
          <SectionContent
            section={sectionKey(active.href)}
            tenant={tenant}
            membership={membership}
            selfName={memberDisplayName(me.data)}
            email={me.data.email}
            capabilities={capabilities}
          />
        </div>
      </div>
    </div>
  );
}

function sectionKey(href: string): string {
  const value = href.split("section=")[1];
  return value ?? "organization";
}

function SectionContent({
  section,
  tenant,
  membership,
  selfName,
  email,
  capabilities,
}: {
  section: string;
  tenant: {
    name: string;
    brand: string | null;
    slug: string;
    currency: Currency;
    status: string;
    isolationMode: string;
  };
  membership: {
    id: string;
    role: MemberRole;
    dataScope: "ALL" | "TEAM" | "OWN";
    approvalLimitAmount: number | null;
  };
  selfName: string;
  email: string | null;
  capabilities: Capability[];
}) {
  switch (section) {
    case "members":
      return (
        <MembersSection
          selfMembershipId={membership.id}
          canManage={capabilities.includes("member.invite")}
          canGrantOwner={capabilities.includes("member.owner.grant")}
          currency={tenant.currency}
          role={membership.role}
        />
      );
    case "fields":
      return <FieldsSection />;
    case "print":
      return <PrintSection />;
    case "input":
      return <InputSection />;
    case "units":
      return <MeasureUnitsSection />;
    case "codes":
      return <CodeRulesSection canEdit={capabilities.includes("settings.edit")} />;
    case "audit":
      return <AuditSection />;
    case "import":
      return <ImportSection />;
    case "billing":
      return <BillingSection />;
    default:
      return (
        <OrgSection tenant={tenant} membership={membership} selfName={selfName} email={email} />
      );
  }
}

function OrgSection({
  tenant,
  membership,
  selfName,
  email,
}: {
  tenant: {
    name: string;
    brand: string | null;
    slug: string;
    currency: Currency;
    status: string;
    isolationMode: string;
  };
  membership: {
    role: MemberRole;
    dataScope: "ALL" | "TEAM" | "OWN";
    approvalLimitAmount: number | null;
  };
  selfName: string;
  email: string | null;
}) {
  const limit = membership.approvalLimitAmount;
  const ia = useWorkspaceIA();
  return (
    <div className="grid gap-6">
      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface px-5 py-3">
          <h2 className="py-2 text-sm font-medium text-ink-900">组织资料</h2>
          <dl>
            <Field label="组织名称" value={tenant.name} />
            <Field label="品牌抬头" value={tenant.brand ?? "—"} hint="用于报价页与打印单证抬头" />
            <Field
              label="公司标识"
              value={<code className="font-mono text-xs">{tenant.slug}</code>}
              hint="和技术支持沟通时提供这一串即可"
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
              value={selfName}
              hint={selfName !== email && email ? email : undefined}
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
            <Field
              label="窗口"
              value={
                ia === "new"
                  ? "事项 ⌘1 · 资源 ⌘2 · 设置 ⌘3"
                  : "工作台 ⌘1 · 审批 ⌘2 · 业务 ⌘3 · 日志 ⌘4"
              }
            />
            <Field label="设置" value="组织与设置 ⌘," />
            <Field label="打印" value="任意页面调用打印面板，桌面版直连打印机" />
            <Field label="外设" value="扫码枪、电子秤、标签机即插即用" />
          </dl>
        </section>
      </div>

      <p className="text-xs text-ink-400">
        公司资料由平台管理员维护；成员邀请与权限在「成员与权限」分栏调整。需要改公司名、抬头或增加账号数，
        <SupportMailto
          className="text-indigo-600 underline underline-offset-2"
          label="写信给我们"
        />{" "}
        或联系你的对接人。
      </p>
    </div>
  );
}

/**
 * 客户与字段：只做汇总与跳转，治理入口长在选项被使用的地方（P1 就地治理）。
 * 这里不复制一套治理 UI，避免出现两份「哪个才是真的」。
 */
function FieldsSection() {
  return (
    <div className="grid gap-6">
      <FieldOptionsSummary />
      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">客户与字段</h2>
        <p className="mt-1 text-xs text-ink-400">
          客户等级、样品品类、样品成分、联系人角色都是公司共享选项：任何成员都能增删改、排序、合并。
          治理入口就在使用现场，看到哪里不对就地改。
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Link
            href="/panorama/customers?manageTiers=1"
            className="rounded-lg border border-line bg-paper px-4 py-3 hover:border-indigo-600"
          >
            <div className="text-sm font-medium text-ink-900">管理客户等级</div>
            <p className="mt-1 text-xs text-ink-400">改名、排序、停用后恢复、合并历史客户。</p>
          </Link>
          <Link
            href="/panorama/samples?manageOptions=1"
            className="rounded-lg border border-line bg-paper px-4 py-3 hover:border-indigo-600"
          >
            <div className="text-sm font-medium text-ink-900">管理品类与成分</div>
            <p className="mt-1 text-xs text-ink-400">
              只影响后续建议，不改历史单据；要改历史走「合并」。
            </p>
          </Link>
        </div>
        <p className="mt-3 text-xs text-ink-400">
          用量见上方汇总；改名、排序、停用与合并都在使用现场完成，这里只做入口。
        </p>
      </section>
    </div>
  );
}

/** 打印与外设：打印是全局抽屉，不占一级入口，这里只放使用说明与排障入口。 */
function PrintSection() {
  return (
    <div className="grid gap-6">
      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">打印与外设</h2>
        <p className="mt-1 text-xs text-ink-400">
          打印面板在任意页面都能打开（顶栏「打印」），不单独占一个窗口。寄样标签、报价单与对账单都在那里发起。
        </p>
        <dl className="mt-2">
          <Field label="标签机" value="即插即用，打印面板选择设备即可" />
          <Field label="扫码枪" value="按键盘输入处理，不需要额外驱动" />
          <Field label="电子秤" value="串口/USB 接入后在寄样与出库流程可用" />
          <Field
            label="故障排查"
            value={<SupportMailto className="text-indigo-600 underline" label="联系技术支持" />}
            hint="带上设备型号与打印面板里的错误提示"
          />
        </dl>
      </section>
      <SalesContactSection />
    </div>
  );
}

/**
 * 业务员联系方式：样卡与客户报价页共用一份。
 *
 * 这里允许留空保存（半成品也是有效状态），但打印样卡时会显式提示缺字段；
 * 不做「猜一个电话填进去」——纸上印错电话比印不出来更糟。
 */
function SalesContactSection() {
  const api = useApi();
  const queryClient = useQueryClient();
  const contactQuery = useQuery({
    queryKey: ["settings", "sales-contact"],
    queryFn: () => api.salesContact(),
  });
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!contactQuery.data) return;
    setName(contactQuery.data.name);
    setPhone(contactQuery.data.phone);
  }, [contactQuery.data]);

  const save = useMutation({
    mutationFn: () => api.updateSalesContact({ name, phone }),
    onSuccess: () => {
      setFeedback("已保存：下次打印的样卡与二维码页会使用新联系方式");
      void queryClient.invalidateQueries({ queryKey: ["settings", "sales-contact"] });
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "保存失败，请稍后重试");
    },
  });

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-sm font-medium text-ink-900">业务员联系方式</h2>
      <p className="mt-1 text-xs text-ink-400">
        样卡背面、二维码扫码页与客户报价页共用这份名片。留空也能保存，但打印样卡前必须先填电话。
      </p>
      {contactQuery.isPending ? (
        <Spinner />
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs text-ink-400">
            姓名
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
              placeholder="例如：孙巨中"
            />
          </label>
          <label className="grid gap-1 text-xs text-ink-400">
            电话
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              maxLength={32}
              inputMode="tel"
              className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
              placeholder="例如：13800000000"
            />
          </label>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              className="min-h-11"
              disabled={save.isPending}
              onClick={() => {
                setFeedback(null);
                save.mutate();
              }}
            >
              {save.isPending ? "保存中…" : "保存联系方式"}
            </Button>
            {feedback ? (
              <span className="text-xs text-ink-700" role="status">
                {feedback}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 输入与识别：说明「预填 + 逐字段确认」的边界。
 *
 * OCR 结论（WAN-192）是可预填字段逐字段改正、不可预填字段留空；
 * 这里不提供第二套配置，不让用户以为模型能替他们猜克重/门幅。
 */
function InputSection() {
  return (
    <div className="grid gap-6">
      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">输入与识别</h2>
        <p className="mt-1 text-xs text-ink-400">
          一段话或一张照片进来，系统先给理解卡；识别只是预填，关键字段必须由人确认后才算数。
        </p>
        <dl className="mt-2">
          <Field label="可预填" value="联系人、职务、手机/固话、邮箱、地址、成分" />
          <Field
            label="必须人工录入"
            value="克重、门幅、批号、主营、品名"
            hint="标签上经常没有这些信息，模型容易编；系统宁可留空也不猜。"
          />
          <Field label="出处" value="每个字段都记录来自名片、标签、历史还是人工" />
          <Field label="识别失败" value="保留原件可回看，未识别字段高亮为待补，不假装成功" />
        </dl>
      </section>
      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">从一句话开始</h2>
        <p className="mt-1 text-xs text-ink-400">
          新建客户、样品或报价都可以从同一个输入框开始；事项里卡住时会提示下一步要补什么。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href="/items"
            className="inline-flex min-h-11 items-center rounded-md bg-ink-900 px-4 text-sm text-white hover:bg-ink-700"
          >
            去事项
          </Link>
          <Link
            href="/resources"
            className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
          >
            去资源
          </Link>
        </div>
      </section>
    </div>
  );
}

/**
 * 默认计量单位：公司层面的录入习惯。
 *
 * 克重与门幅的单位是有限集合，所以单位不猜：录入面上是「数值框 + 单位下拉」，
 * 下拉默认选中这里配的单位。用户随时可以改成别的单位，改公司默认值不会动历史数据。
 */
function MeasureUnitsSection() {
  const api = useApi();
  const queryClient = useQueryClient();
  const defaults = useMeasureUnits();
  const [weight, setWeight] = useState<WeightUnit>(defaults.weight);
  const [width, setWidth] = useState<WidthUnit>(defaults.width);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    setWeight(defaults.weight);
    setWidth(defaults.width);
  }, [defaults.weight, defaults.width]);

  const save = useMutation({
    mutationFn: () => api.updateMeasureUnits({ weight, width }),
    onSuccess: (saved) => {
      setFeedback(`已保存：之后新建样品的克重按 ${WEIGHT_UNIT_LABEL[saved.weight]}、门幅按 ${WIDTH_UNIT_LABEL[saved.width]} 录入`);
      void queryClient.invalidateQueries({ queryKey: ["settings", "measure-units"] });
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "保存失败，请稍后重试");
    },
  });

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-sm font-medium text-ink-900">默认计量单位</h2>
      <p className="mt-1 text-xs text-ink-400">
        克重与门幅的单位是固定的几档，所以录入时分开填：数值填数字，单位用下拉选。
        这里配的是下拉的默认值，只影响之后新建的样品；已经录好的样品保留自己的单位。
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-ink-400">
          默认克重单位
          <select
            className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
            value={weight}
            onChange={(event) => setWeight(event.target.value as WeightUnit)}
          >
            {WEIGHT_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {WEIGHT_UNIT_LABEL[unit]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-ink-400">
          默认门幅单位
          <select
            className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
            value={width}
            onChange={(event) => setWidth(event.target.value as WidthUnit)}
          >
            {WIDTH_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {WIDTH_UNIT_LABEL[unit]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          className="min-h-11"
          disabled={save.isPending}
          onClick={() => {
            setFeedback(null);
            save.mutate();
          }}
        >
          {save.isPending ? "保存中…" : "保存默认单位"}
        </Button>
        {feedback ? (
          <span className="text-xs text-ink-700" role="status">
            {feedback}
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-xs text-ink-400">
        克重区间筛选统一按 g/m² 比较，门幅按 cm；所以不管你用哪个单位录，筛选口径都不会漂。
      </p>
    </section>
  );
}

/** 审计日志：从旧一级入口「日志」搬进设置，操作日志本身仍是只读。 */
function AuditSection() {
  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-line bg-surface px-5 py-3">
        <h2 className="text-sm font-medium text-ink-900">审计日志</h2>
        <p className="mt-1 text-xs text-ink-400">
          只读：没有编辑、删除或撤销入口。范围由服务端按角色决定（全公司 / 我的操作）。
        </p>
      </section>
      <AuditLogView />
    </div>
  );
}

/** 数据导入：统一入口，格式说明与模板下载在对应业务页。 */
function ImportSection() {
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-sm font-medium text-ink-900">数据导入</h2>
      <p className="mt-1 text-xs text-ink-400">
        先下载模板再填，预览确认后才写入；未知的等级 / 品类会标出来让你选择「存为选项 / 仅本次 /
        映射到已有」。
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Link
          href="/panorama/customers?import=1"
          className="rounded-lg border border-line bg-paper px-4 py-3 hover:border-indigo-600"
        >
          <div className="text-sm font-medium text-ink-900">导入客户</div>
          <p className="mt-1 text-xs text-ink-400">客户名、等级、联系方式；重名客户会先提示。</p>
        </Link>
        <Link
          href="/panorama/samples?import=1"
          className="rounded-lg border border-line bg-paper px-4 py-3 hover:border-indigo-600"
        >
          <div className="text-sm font-medium text-ink-900">导入样品</div>
          <p className="mt-1 text-xs text-ink-400">编号、品名、成分、克重、成本底线。</p>
        </Link>
      </div>
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

/** 用量与订阅：老板只读（账单由平台侧维护，本期不做自助）。 */
function BillingSection() {
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
        // 拿不到就显示占位，不影响其它分栏。
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const percent = Math.max(0, Math.min(100, data?.percent ?? 0));
  const tone =
    data?.state === "PAUSED"
      ? "bg-vermilion-600"
      : data?.state === "WARN"
        ? "bg-amber-600"
        : "bg-indigo-600";

  return (
    <div className="grid gap-6">
      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-medium text-ink-900">本月 AI 额度（credits）</h2>
          <span className="font-mono text-xs text-ink-400">{data?.period ?? "—"}</span>
        </div>
        {data ? (
          <>
            <p className="mt-2 text-2xl font-semibold text-ink-900">
              {data.creditsUsed.toLocaleString()}
              <span className="text-sm font-normal text-ink-400">
                {" / "}
                {data.creditsIncluded === null
                  ? "不限"
                  : data.creditsIncluded.toLocaleString()}{" "}
                credits
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
          </>
        ) : (
          <p className="mt-2 text-xs text-ink-400">暂时读不到用量数据，稍后刷新重试。</p>
        )}
      </section>

      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-sm font-medium text-ink-900">订阅</h2>
        <p className="mt-1 text-xs text-ink-400">
          套餐、发票与付款方式由平台侧维护，本期这里只读展示。需要变更请
          {SUPPORT_EMAIL ? (
            <SupportMailto className="text-indigo-600 underline" label="联系对接人" />
          ) : (
            <span>联系你的对接人或平台管理员</span>
          )}
          。
        </p>
      </section>
    </div>
  );
}
