import { Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useEffect, useState } from "react";
import {
  Amount,
  Badge,
  Button,
  Card,
  EmptyState,
  Loading,
  Page,
  SectionTitle,
} from "../../components/ui";
import { useApprovals, useCustomers, usePanorama } from "../../lib/hooks";
import { formatMoneyShort, maskPhone, relativeTime, shortDate } from "../../lib/format";
import { api } from "../../lib/runtime";
import { openQuote } from "../../lib/nav";
import type { ShareSummary } from "../../lib/mobile-api";

export default function CustomerPage() {
  const router = useRouter();
  const id = router.params.id ?? "";
  const customers = useCustomers(100);
  const panorama = usePanorama();
  const approvals = useApprovals();
  const [revealPhone, setRevealPhone] = useState(false);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [shareError, setShareError] = useState<string | null>(null);

  const customer = (customers.data ?? []).find((entry) => entry.id === id);
  const quotes = (panorama.data?.items ?? []).filter(
    (item) => item.customerId === id && item.kind === "quote",
  );
  const pending = (approvals.data?.items ?? []).filter((item) => item.customerId === id);

  useEffect(() => {
    if (customer) void Taro.setNavigationBarTitle({ title: customer.name });
  }, [customer]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const quoteIds = quotes.map((quote) => quote.id);
      if (quoteIds.length === 0) return;
      try {
        const results = await Promise.all(quoteIds.map((quoteId) => api.listQuoteShares(quoteId)));
        if (!cancelled) setShares(results.flat());
      } catch {
        if (!cancelled) setShareError("报价链接访问数据需联网读取（待 Track E 联调）");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // quotes 来自远程数据，按 id 串去重，避免每次渲染重新请求。
  }, [quotes.map((quote) => quote.id).join(",")]);

  if (customers.isLoading && !customers.data)
    return (
      <Page>
        <Loading />
      </Page>
    );

  if (!customer) {
    return (
      <Page>
        <EmptyState title="客户不存在" desc="可能已交接给其他同事，或链接已过期。" />
      </Page>
    );
  }

  return (
    <Page>
      <View className="page-title">{customer.name}</View>
      <View className="page-sub">
        {customer.code} · {customer.tier} · 归属数据范围由服务端决定
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
                <View className="list-title">{item.title}</View>
                <View className="list-sub">{item.summary}</View>
              </View>
              {item.amountCents !== null && (
                <Amount>{formatMoneyShort(item.amountCents, item.currency ?? "CNY")}</Amount>
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
                <View className="list-title">{quote.title}</View>
                <View className="list-sub">
                  {quote.summary} · {shortDate(quote.createdAt)}
                </View>
              </View>
              <Badge tone={quote.status === "DRAFT" ? "warn" : "accent"}>{quote.status}</Badge>
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

      <View className="footnote">
        客户 360 在此只展示移动端需要的上下文；完整时间线与交接记录在 PC 端。
      </View>
    </Page>
  );
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
