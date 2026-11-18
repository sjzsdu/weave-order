import { Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useEffect, useState } from "react";
import { ApiError } from "@weave-order/core";
import type { CustomerTimelineEvent } from "@weave-order/schema";
import {
  Amount,
  Badge,
  Button,
  Card,
  EmptyState,
  Loading,
  NavBar,
  Page,
  SectionTitle,
} from "../../components/ui";
import { useCustomer360, useCustomerTimeline } from "../../lib/hooks";
import { formatMoneyShort, maskPhone, ownerLabel, relativeTime, shortDate } from "../../lib/format";
import { api } from "../../lib/runtime";
import { openQuote } from "../../lib/nav";
import type { ShareSummary } from "../../lib/mobile-api";

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  SENT: "已发出",
  ACCEPTED: "客户接受",
  REJECTED: "已驳回",
  EXPIRED: "已过期",
  CONFIRMED: "已确认",
  SHIPPED: "已发出",
  DELIVERED: "已签收",
  CANCELLED: "已取消",
  PARTIAL: "部分收款",
  PAID: "已收清",
  IN_PRODUCTION: "生产中",
};

/**
 * 移动端客户 360。
 *
 * 数据源与 PC 端是同一个聚合接口（`/api/customers/:id` + `/timeline`），
 * 页面只负责排版：未决 / 在途 / 应收三个数字不再由前端拿列表自己数。
 */
export default function CustomerPage() {
  const router = useRouter();
  const id = router.params.id ?? "";
  const detail = useCustomer360(id);
  const timeline = useCustomerTimeline(id);
  const [revealPhone, setRevealPhone] = useState(false);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [shareError, setShareError] = useState<string | null>(null);

  const customer = detail.data?.customer;
  const summary = detail.data?.summary;
  const context = detail.data?.context;
  const events = timeline.data?.events ?? [];
  const pending = events.filter(
    (event) =>
      (event.kind === "quote" || event.kind === "sample_shipment") && event.status === "DRAFT",
  );
  const quotes = events.filter((event) => event.kind === "quote");

  useEffect(() => {
    if (customer) void Taro.setNavigationBarTitle({ title: customer.name });
  }, [customer]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const quoteIds = quotes.map((quote) => quote.sourceId);
      if (quoteIds.length === 0) return;
      try {
        const results = await Promise.all(quoteIds.map((quoteId) => api.listQuoteShares(quoteId)));
        if (!cancelled) setShares(results.flat());
      } catch {
        if (!cancelled) setShareError("报价链接访问数据需联网读取");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // quotes 来自远程数据，按 id 串去重，避免每次渲染重新请求。
  }, [quotes.map((quote) => quote.sourceId).join(",")]);

  if (detail.isLoading && !detail.data) {
    return (
      <Page>
        <NavBar title="客户 360" />
        <Loading />
      </Page>
    );
  }

  if (detail.isError || !customer || !summary) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <Page>
        <NavBar title="客户 360" />
        <EmptyState
          title={notFound ? "客户不存在" : "客户 360 暂时不可用"}
          desc={
            notFound
              ? "可能已交接给其他同事，或链接已过期。"
              : detail.error instanceof Error
                ? detail.error.message
                : "请稍后重试。"
          }
        />
      </Page>
    );
  }

  return (
    <Page>
      <NavBar title={customer.name} subtitle={customer.code} />
      <View className="page-sub">
        {customer.tier} · 负责人 {ownerLabel(detail.data?.ownerName, detail.data?.ownerId)}
      </View>

      <Card>
        <View className="list-row">
          <View>
            <View className="list-title">{customer.contactName ?? "未填联系人"}</View>
            <View className="list-sub">
              {revealPhone
                ? (customer.contactPhone ?? "未留电话")
                : maskPhone(customer.contactPhone)}
            </View>
          </View>
          <Text className="link" onClick={() => setRevealPhone((value) => !value)}>
            {revealPhone ? "隐藏" : "显示"}
          </Text>
        </View>
        {customer.contactEmail && (
          <View className="list-row">
            <View className="list-title">{customer.contactEmail}</View>
            <Text className="tiny">邮箱</Text>
          </View>
        )}
        <View className="actions">
          <Button
            variant="ghost"
            onClick={() => {
              if (!customer.contactPhone) {
                void Taro.showToast({ title: "客户未留电话", icon: "none" });
                return;
              }
              void Taro.makePhoneCall({ phoneNumber: customer.contactPhone });
            }}
          >
            打电话
          </Button>
          <Button onClick={() => openQuote({ customerId: customer.id, mode: "paste" })}>
            快速报价
          </Button>
        </View>
        <View className="footnote">定位只在点击「签到」时取一次；手机不做后台定位。</View>
      </Card>

      <SectionTitle title="数字面板" hint="与 PC 端同一口径" />
      <Card className="card-flat">
        <View className="list-row">
          <View>
            <View className="list-sub">未决报价</View>
            <View className="list-title">{summary.pendingQuoteCount}</View>
          </View>
          <View>
            <View className="list-sub">在途寄样</View>
            <View className="list-title">{summary.inTransitSampleCount}</View>
          </View>
          <View>
            <View className="list-sub">逾期应收</View>
            <View className="list-title">{summary.overdueReceivableCount}</View>
          </View>
        </View>
        <View className="list-row">
          <View>
            <View className="list-sub">应收余额</View>
            {summary.receivableBalance.length === 0 ? (
              <View className="muted">无未收金额</View>
            ) : (
              summary.receivableBalance.map((money) => (
                <Amount key={money.currency}>
                  {formatMoneyShort(money.amount, money.currency)}
                </Amount>
              ))
            )}
          </View>
          <View>
            <View className="list-sub">最近往来</View>
            <View className="list-title">
              {summary.lastContactAt ? relativeTime(summary.lastContactAt) : "—"}
            </View>
          </View>
        </View>
      </Card>

      {context && context.preferenceNotes.length > 0 && (
        <>
          <SectionTitle title="选样偏好" hint="客户上下文" />
          <Card className="card-flat">
            {context.preferenceNotes.map((note) => (
              <View key={note} className="muted">
                · {note}
              </View>
            ))}
          </Card>
        </>
      )}

      <SectionTitle
        title="待处理"
        hint="客户相关草稿"
        extra={<Badge tone={pending.length ? "warn" : "neutral"}>{pending.length} 条</Badge>}
      />
      {pending.length === 0 ? (
        <Card className="card-flat">
          <View className="muted">没有待批的报价或寄样。</View>
        </Card>
      ) : (
        pending.map((item) => (
          <Card key={item.id} className="card-draft">
            <View className="row">
              <View>
                <View className="list-title">{eventTitle(item)}</View>
                <View className="list-sub">{STATUS_LABEL[item.status] ?? item.status}</View>
              </View>
              {item.amount && (
                <Amount>{formatMoneyShort(item.amount.amount, item.amount.currency)}</Amount>
              )}
            </View>
            <View className="actions">
              <Button small onClick={() => void Taro.switchTab({ url: "/pages/approvals/index" })}>
                去审批
              </Button>
            </View>
          </Card>
        ))
      )}

      <SectionTitle title="报价历史" hint="只读快照；改价走审批" />
      {quotes.length === 0 ? (
        <Card className="card-flat">
          <View className="muted">还没有报价记录。</View>
        </Card>
      ) : (
        quotes.map((quote) => (
          <Card key={quote.id} className="card-flat">
            <View className="row">
              <View>
                <View className="list-title">{eventTitle(quote)}</View>
                <View className="list-sub">
                  {STATUS_LABEL[quote.status] ?? quote.status} · {shortDate(quote.occurredAt)}
                </View>
              </View>
              {quote.amount && (
                <Amount>{formatMoneyShort(quote.amount.amount, quote.amount.currency)}</Amount>
              )}
            </View>
          </Card>
        ))
      )}

      <SectionTitle title="报价链接访问" hint="首次查看 / 接受 / 提问才提醒" />
      <Card className="card-flat">
        {shareError && <View className="muted">{shareError}</View>}
        {!shareError && shares.length === 0 && (
          <View className="muted">还没有生成过分享链接。</View>
        )}
        {shares.map((entry) => (
          <ShareRow key={entry.share.id} entry={entry} />
        ))}
      </Card>

      <View className="footnote">完整时间线与交接记录在 PC 端客户 360。</View>
    </Page>
  );
}

function eventTitle(event: CustomerTimelineEvent): string {
  if (event.kind === "order") return `订单 · ${event.code ?? ""}`;
  if (event.kind === "quote") return `报价 · ${event.sourceId.slice(0, 8).toUpperCase()}`;
  if (event.kind === "sample_shipment") {
    return `寄样 · ${event.sourceId.slice(0, 8).toUpperCase()}`;
  }
  return event.code ?? event.kind;
}

function ShareRow({ entry }: { entry: ShareSummary }) {
  const status = entry.share.revokedAt
    ? "已撤回"
    : entry.viewCount > 0
      ? `已看 ${entry.viewCount} 次`
      : "未打开";
  return (
    <View className="list-row">
      <View>
        <View className="list-title">
          v{entry.share.version} · {status}
        </View>
        <View className="list-sub">
          到期 {shortDate(entry.share.expiresAt)}
          {entry.lastViewedAt ? ` · 最近 ${relativeTime(entry.lastViewedAt)}` : ""}
        </View>
      </View>
      <Badge tone={entry.viewCount > 0 ? "accent" : "neutral"}>
        {entry.share.requirePhoneTail ? "尾号验证" : "直开"}
      </Badge>
    </View>
  );
}
