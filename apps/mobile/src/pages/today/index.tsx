import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import type { ApprovalItem } from "@weave-order/schema";
import { actorTypeLabel, auditActionLabel, auditEntityLabel } from "@weave-order/schema";
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
} from "../../components/ui";
import { SwipeCard } from "../../components/SwipeCard";
import { useApprovalDecision } from "../../domain/approval/use-approval-decision";
import {
  useApprovals,
  useAudit,
  useOfflineBanner,
  usePanorama,
  useQueueState,
} from "../../lib/hooks";
import { formatMoneyShort, greeting, relativeTime } from "../../lib/format";
import { IS_MOCK } from "../../lib/runtime";
import { ROUTE_PATHS, enterQuote, goTab, openApprovals, openCustomer } from "../../routes";

/**
 * 待办（原「今日」）：一屏只回答一个问题 —— 今天有什么必须由我决定。
 *
 * 首屏顺序固定：问候 → 结论 → 开报价 → 待批卡 → 小织在跟 → 异常 → 动态（折叠）。
 * 角色 chip、快捷块、三列统计、占位块都删掉：它们是「逛一逛」，不是「办事」。
 */
export default function TodayPage() {
  const approvals = useApprovals();
  const panorama = usePanorama();
  const audit = useAudit(6);
  const banner = useOfflineBanner();
  const queue = useQueueState();
  const [dynamicsOpen, setDynamicsOpen] = useState(false);

  const pending = approvals.data?.items ?? [];
  const pendingAmount = pending.reduce((sum, item) => sum + (item.amountCents ?? 0), 0);
  const stats = panorama.data?.stats;
  const rejectedCount = stats?.rejectedCount ?? 0;
  const agentDoneCount = Math.max(stats?.todayAgentDoneCount ?? 0, audit.data?.length ?? 0);

  const decision = useApprovalDecision({
    onApproved: () => void Taro.showToast({ title: "已批准", icon: "success" }),
    onRejected: () => void Taro.showToast({ title: "已驳回", icon: "success" }),
  });

  /** 待办左滑驳回：现场快速驳回不写长原因，原因记为「其他」，需要写理由就去审批页。 */
  const quickReject = async (item: ApprovalItem) => {
    const result = await Taro.showModal({
      title: "驳回这条草稿？",
      content: "待办里快速驳回，原因记为「其他」；要写原因请到审批页。",
      confirmText: "驳回",
      confirmColor: "#b3261e",
    });
    if (result.confirm) decision.schedule(item, "REJECT", "待办快速驳回");
  };

  return (
    <Page>
      <View className="page-title">{greeting()}</View>
      <View className="page-sub">小织在跟，你只做决定</View>

      {IS_MOCK && (
        <View className="mock-banner">
          演示数据（Mock）：契约端点本地实现，切 `TARO_APP_MOCK=0` 连真后端。
        </View>
      )}

      <View className="headline">
        <Text className="headline-main">
          {pending.length > 0 ? `今天 ${pending.length} 件等你决定` : "今天没有要你决定的事"}
        </Text>
        {pendingAmount > 0 && (
          <Text className="headline-amount"> · 卡住 {formatMoneyShort(pendingAmount)}</Text>
        )}
      </View>

      <Button block onClick={() => enterQuote({ mode: "paste" })}>
        ＋ 开一个报价
      </Button>

      {banner.show && (
        <View style={{ marginTop: 16 }}>
          <OfflineBanner text={banner.text} onClick={() => goTab(ROUTE_PATHS.more)} />
        </View>
      )}
      {queue.total > 0 && (
        <View className="queue-chip" onClick={() => goTab(ROUTE_PATHS.more)}>
          {queue.conflicts > 0
            ? `${queue.conflicts} 条操作冲突，去「我的」确认`
            : `${queue.pending} 条改动已存本地，去「我的」查看`}
        </View>
      )}

      <SectionTitle
        title="待你决定"
        hint="批准立即生效，5 秒内可撤销"
        extra={
          <Text className="link" onClick={() => openApprovals()}>
            查看全部
          </Text>
        }
      />

      {approvals.isLoading && !approvals.data ? (
        <Loading />
      ) : pending.length === 0 ? (
        <EmptyState title="没有待批的草稿" desc="小织在跟客户，有新的会出现在这里。" />
      ) : (
        <View>
          {pending.slice(0, 2).map((item, index) =>
            index === 0 ? (
              <SwipeCard
                key={item.id}
                disabled={decision.busy}
                onApprove={() => decision.schedule(item, "APPROVE")}
                onReject={() => void quickReject(item)}
              >
                <PendingCard
                  item={item}
                  primary
                  busy={decision.busy}
                  onApprove={() => decision.schedule(item, "APPROVE")}
                />
              </SwipeCard>
            ) : (
              <View key={item.id} onClick={() => openApprovals()}>
                <PendingCard item={item} />
              </View>
            ),
          )}
          {pending.length > 2 && (
            <Text className="link" onClick={() => openApprovals()}>
              还有 {pending.length - 2} 件
            </Text>
          )}
        </View>
      )}

      <SectionTitle title="小织在跟" hint="它的动作都在审计里，可追溯" />
      <Card>
        <View className="stat-line">
          <Text>报价已发出 {stats?.sentQuoteCount ?? "—"} 份</Text>
          <Text className="muted">待批 {stats?.pendingCount ?? pending.length} 单</Text>
        </View>
        <View className="stat-line">
          <Text>寄样已确认 {stats?.confirmedShipmentCount ?? "—"} 单</Text>
          <Text className="muted">被驳回 {rejectedCount} 单</Text>
        </View>
      </Card>

      {rejectedCount > 0 && (
        <View>
          <SectionTitle title="异常" />
          <Card className="card-flat" onClick={() => openApprovals()}>
            <View className="row">
              <View>
                <View className="list-title">{rejectedCount} 单被驳回，需要重新报价</View>
                <View className="list-sub">点开审批页处理，或让小织再试一次</View>
              </View>
              <Badge tone="danger">需处理</Badge>
            </View>
          </Card>
        </View>
      )}

      <View className="collapse-row" onClick={() => setDynamicsOpen((value) => !value)}>
        <Text>小织今天做了 {agentDoneCount} 件事</Text>
        <Text className="muted">{dynamicsOpen ? "收起" : "展开"}</Text>
      </View>

      {dynamicsOpen && (
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
                      {actorTypeLabel(entry.actorType)} · {auditActionLabel(entry.action)}
                    </View>
                    <View className="timeline-meta">
                      {auditEntityLabel(entry.entityType)} · {relativeTime(entry.createdAt)}
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}
        </Card>
      )}

      {decision.pending && (
        <View className="undo-bar undo-bar-tab">
          <Text>
            {decision.pending.decision === "APPROVE" ? "已批准" : "已驳回"} ·{" "}
            {decision.pending.item.title} · {decision.secondsLeft}s 后提交
          </Text>
          <Text className="undo-action" onClick={decision.cancelUndo}>
            撤销
          </Text>
        </View>
      )}
    </Page>
  );
}

/**
 * 一张待批卡：默认只读（点开去审批页），第一张给「改价 / 批准」。
 * 信息压到三行：标题（客户 + 规格）、摘要、金额。
 */
function PendingCard({
  item,
  primary = false,
  busy = false,
  onApprove,
}: {
  item: ApprovalItem;
  primary?: boolean;
  busy?: boolean;
  onApprove?: () => void;
}) {
  return (
    <Card className="card-draft">
      <View className="row">
        <View className="pending-main">
          <View className="list-title">{item.title}</View>
          <View className="list-sub truncate">{item.summary}</View>
        </View>
        {item.amountCents !== null && (
          <Amount>{formatMoneyShort(item.amountCents, item.currency ?? "CNY")}</Amount>
        )}
      </View>

      <View className="pending-meta">
        <Badge tone="warn">{item.kind === "quote" ? "报价草稿" : "寄样草稿"}</Badge>
        {typeof item.version === "number" && <Badge>v{item.version}</Badge>}
        <Text className="tiny">{relativeTime(item.createdAt)}</Text>
      </View>

      {primary && (
        <View className="actions">
          <Button variant="ghost" small onClick={() => openCustomer(item.customerId)}>
            看客户
          </Button>
          {item.kind === "quote" && (
            <Button
              variant="ghost"
              small
              onClick={() => enterQuote({ mode: "edit", quoteId: item.id })}
            >
              改价
            </Button>
          )}
          <Button small loading={busy} onClick={onApprove}>
            批准
          </Button>
        </View>
      )}
    </Card>
  );
}
