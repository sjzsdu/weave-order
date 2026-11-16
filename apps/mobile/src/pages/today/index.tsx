import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import type { ApprovalItem } from "@weave-order/schema";
import {
  Amount,
  Badge,
  Button,
  Card,
  EmptyState,
  Loading,
  OfflineBanner,
  Page,
  SectionTitle,
  Stat,
} from "../../components/ui";
import {
  useAudit,
  useApprovals,
  useCustomers,
  useOfflineBanner,
  usePanorama,
  useQueueState,
} from "../../lib/hooks";
import { formatMoneyShort, relativeTime } from "../../lib/format";
import { ROLES, ROLE_LABEL, ROLE_QUICK_ACTIONS, blocksForRole, isRole } from "../../lib/roles";
import type { Role } from "../../lib/roles";
import { IS_MOCK, prefs } from "../../lib/runtime";
import { goTab, openCamera, openCustomer, openQuote, ROUTES } from "../../lib/nav";

const ACTION_LABEL: Record<string, string> = {
  QUOTE_DRAFT_GENERATED: "生成了报价草稿",
  QUOTE_CONFIRMED: "报价已批准",
  QUOTE_REJECTED: "报价被驳回",
  SAMPLE_SHIPMENT_DRAFTED: "建了寄样单草稿",
  SAMPLE_SHIPMENT_CONFIRMED: "寄样单已确认",
  CUSTOMER_CONTEXT_UPDATED: "更新了客户上下文",
  REVISION_REQUESTED: "收到改价请求",
  REVISION_RESOLVED: "改价请求已裁决",
  QUOTE_SHARE_CREATED: "生成了报价链接",
};

const QUICK_META: Record<string, { icon: string; label: string; action: () => void }> = {
  paste: { icon: "📋", label: "粘贴微信", action: () => openQuote({ mode: "paste" }) },
  quote: { icon: "🧾", label: "快速报价", action: () => openQuote({ mode: "paste" }) },
  camera: { icon: "📷", label: "拍照找样", action: () => openCamera("find") },
  scan: { icon: "🔍", label: "扫运单", action: () => openCamera("waybill") },
  signature: { icon: "✍️", label: "拍签收", action: () => openCamera("signature") },
  sample: { icon: "🧵", label: "建样品", action: () => openCamera("sample") },
  receipt: { icon: "💳", label: "拍回款", action: () => openCamera("receipt") },
  decide: { icon: "✅", label: "去批单", action: () => goTab(ROUTES.approvals) },
  report: {
    icon: "📊",
    label: "看周报",
    action: () => void Taro.showToast({ title: "经营看板在 PC 端（手机不做宽表）", icon: "none" }),
  },
};

export default function TodayPage() {
  const [role, setRole] = useState<Role>(() => {
    const saved = prefs.getRole();
    return isRole(saved) ? saved : "sales";
  });
  const panorama = usePanorama();
  const approvals = useApprovals();
  const customers = useCustomers(6);
  const audit = useAudit(6);
  const banner = useOfflineBanner();
  const queue = useQueueState();

  const pending = approvals.data?.items ?? [];
  const pendingAmount = pending.reduce((sum, item) => sum + (item.amountCents ?? 0), 0);
  const blocks = blocksForRole(role);
  const quickActions = ROLE_QUICK_ACTIONS[role]
    .map((id) => QUICK_META[id])
    .filter((action): action is NonNullable<typeof action> => Boolean(action));

  const switchRole = async () => {
    try {
      const result = await Taro.showActionSheet({
        itemList: ROLES.map((item) => ROLE_LABEL[item]),
      });
      const picked = ROLES[result.tapIndex ?? -1];
      if (picked) {
        setRole(picked);
        prefs.setRole(picked);
      }
    } catch {
      // 用户取消切换不处理。
    }
  };

  const renderDecide = () => (
    <View key="decide">
      <SectionTitle
        title="待我决定"
        hint="批准或驳回，金额与校验由服务端完成"
        extra={
          <Text className="link" onClick={() => goTab(ROUTES.approvals)}>
            全部
          </Text>
        }
      />
      {approvals.isLoading && !approvals.data ? (
        <Loading />
      ) : pending.length === 0 ? (
        <EmptyState title="今天没有要你决定的事" desc="小织在跟你的客户，有异常会进动态。" />
      ) : (
        pending.slice(0, 2).map((item) => <PendingCard key={item.id} item={item} />)
      )}
    </View>
  );

  const renderBusiness = () => (
    <View key="business">
      <SectionTitle title="经营一句话" hint="今天哪里不对" />
      <Card>
        <View className="row">
          <View>
            <View className="muted">卡在你这里的金额</View>
            <Amount size="lg">{formatMoneyShort(pendingAmount)}</Amount>
          </View>
          <Badge tone={pending.length > 0 ? "warn" : "accent"}>
            {pending.length > 0 ? `${pending.length} 单待批` : "已清空"}
          </Badge>
        </View>
        <View className="divider" />
        <View className="stats">
          <Stat label="客户" value={panorama.data?.stats.customerCount ?? "—"} />
          <Stat label="已发报价" value={panorama.data?.stats.sentQuoteCount ?? "—"} />
          <Stat
            label="待批"
            value={panorama.data?.stats.pendingCount ?? pending.length}
            tone="warn"
          />
        </View>
      </Card>
    </View>
  );

  const renderCustomers = () => (
    <View key="customers">
      <SectionTitle
        title="我的客户"
        hint="最近沟通与快速报价"
        extra={
          <Text className="link" onClick={() => goTab(ROUTES.customers)}>
            客户列表
          </Text>
        }
      />
      <Card>
        {(customers.data ?? []).slice(0, 4).map((customer) => (
          <View key={customer.id} className="list-row" onClick={() => openCustomer(customer.id)}>
            <View>
              <View className="list-title">{customer.name}</View>
              <View className="list-sub">
                {customer.code} · {customer.tier}
              </View>
            </View>
            <Text className="link">360</Text>
          </View>
        ))}
        {customers.data?.length === 0 && (
          <View className="muted">还没有客户，先在 PC 端导入。</View>
        )}
      </Card>
    </View>
  );

  const renderExceptions = () => (
    <View key="exceptions">
      <SectionTitle title="异常" hint="交期、物流、签收，只列需要动的" />
      <Card className="card-flat">
        <View className="row">
          <View>
            <View className="list-title">
              {panorama.data?.stats.rejectedCount
                ? `${panorama.data.stats.rejectedCount} 单被驳回`
                : "暂时没有异常"}
            </View>
            <View className="list-sub">
              {panorama.data?.stats.confirmedShipmentCount
                ? `${panorama.data.stats.confirmedShipmentCount} 单寄样已确认`
                : "小织在盯着，出事了再进动态"}
            </View>
          </View>
          <Badge tone={panorama.data?.stats.rejectedCount ? "danger" : "accent"}>
            {panorama.data?.stats.rejectedCount ? "需处理" : "正常"}
          </Badge>
        </View>
      </Card>
    </View>
  );

  const renderPlaceholder = (id: string) => {
    const block = blocks.find((entry) => entry.id === id);
    if (!block) return null;
    return (
      <View key={id}>
        <SectionTitle title={block.title} hint={block.hint} />
        <Card className="card-flat">
          <View className="muted">{block.hint}。移动端只做现场动作，批量在 PC 端。</View>
        </Card>
      </View>
    );
  };

  return (
    <Page>
      <View className="row">
        <View>
          <View className="page-title">今日</View>
          <View className="page-sub">织序 · 现场决定</View>
        </View>
        <View className="role-chip" onClick={() => void switchRole()}>
          <Text>{ROLE_LABEL[role]}</Text>
          <Text className="muted">切换</Text>
        </View>
      </View>

      {IS_MOCK && (
        <View className="mock-banner">
          演示数据（Mock）：契约端点本地实现，切 `TARO_APP_MOCK=0` 连真后端。
        </View>
      )}
      {banner.show && <OfflineBanner text={banner.text} onClick={() => goTab(ROUTES.more)} />}
      {queue.conflicts > 0 && (
        <View className="mock-banner" onClick={() => goTab(ROUTES.more)}>
          {queue.conflicts} 条操作冲突，需人工选择保留哪一版
        </View>
      )}

      <View className="quick">
        {quickActions.map((action) => (
          <View key={action.label} className="quick-item" onClick={action.action}>
            <View className="tile-icon">{action.icon}</View>
            <View className="quick-label">{action.label}</View>
          </View>
        ))}
      </View>

      {blocks.map((block) => {
        switch (block.id) {
          case "decide":
            return renderDecide();
          case "business":
            return renderBusiness();
          case "customers":
            return renderCustomers();
          case "exceptions":
            return renderExceptions();
          default:
            return renderPlaceholder(block.id);
        }
      })}

      <SectionTitle title="智能体动态" hint="每条都有依据，不只给结论" />
      <Card className="card-flat">
        {audit.isLoading && !audit.data ? (
          <Loading />
        ) : (audit.data ?? []).length === 0 ? (
          <View className="muted">今天还没有智能体动作。</View>
        ) : (
          <View className="timeline">
            {(audit.data ?? []).map((entry) => (
              <View className="timeline-item" key={entry.id}>
                <View className="timeline-dot" />
                <View className="timeline-body">
                  <View className="timeline-title">
                    {entry.actorId} · {ACTION_LABEL[entry.action] ?? entry.action}
                  </View>
                  <View className="timeline-meta">
                    {entry.entityType} · {relativeTime(entry.createdAt)}
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
      </Card>

      <View className="footnote">
        手机只做现场与决定：粘贴原话、改一个价、批一单、分享链接。批量导入、模板编辑、宽表全景留在
        PC。
      </View>
    </Page>
  );
}

function PendingCard({ item }: { item: ApprovalItem }) {
  return (
    <Card className="card-draft">
      <View className="row">
        <View>
          <View className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
            <Badge tone="warn">{item.kind === "quote" ? "报价草稿" : "寄样草稿"}</Badge>
            <Text className="tiny">{relativeTime(item.createdAt)}</Text>
          </View>
          <View className="list-title" style={{ marginTop: 8 }}>
            {item.title}
          </View>
          <View className="list-sub">{item.summary}</View>
        </View>
        {item.amountCents !== null && (
          <Amount>{formatMoneyShort(item.amountCents, item.currency ?? "CNY")}</Amount>
        )}
      </View>
      <View className="actions">
        <Button variant="ghost" small onClick={() => openCustomer(item.customerId)}>
          看客户
        </Button>
        <Button small onClick={() => goTab(ROUTES.approvals)}>
          去批
        </Button>
      </View>
    </Card>
  );
}
