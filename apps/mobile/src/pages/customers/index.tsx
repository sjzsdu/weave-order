import { Input, Text, View } from "@tarojs/components";
import { useMemo, useState } from "react";
import { Badge, Card, EmptyState, Loading, OfflineBanner, Page } from "../../components/ui";
import { useCustomers, useOfflineBanner } from "../../lib/hooks";
import { maskPhone } from "../../lib/format";
import { openCustomer, openQuote } from "../../lib/nav";

const TIER_LABEL: Record<string, string> = {
  VIP: "VIP",
  REGULAR: "常规",
  NEW: "新客",
  COLD: "沉睡",
};

export default function CustomersPage() {
  const { data, isLoading } = useCustomers(100);
  const banner = useOfflineBanner();
  const [keyword, setKeyword] = useState("");

  const filtered = useMemo(() => {
    const list = data ?? [];
    const trimmed = keyword.trim().toLowerCase();
    if (!trimmed) return list;
    return list.filter(
      (customer) =>
        customer.name.toLowerCase().includes(trimmed) ||
        customer.code.toLowerCase().includes(trimmed) ||
        (customer.contactName ?? "").toLowerCase().includes(trimmed),
    );
  }, [data, keyword]);

  return (
    <Page>
      <View className="page-title">客户</View>
      <View className="page-sub">我的客户、360、快速报价；批量分配在 PC 端。</View>

      {banner.show && <OfflineBanner text={banner.text} />}

      <Input
        className="input"
        value={keyword}
        placeholder="搜客户名 / 编号 / 联系人"
        onInput={(event) => setKeyword(event.detail.value)}
      />
      <View className="footnote">共 {filtered.length} 位客户 · 手机号默认脱敏</View>

      {isLoading && !data ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={keyword ? "没有匹配的客户" : "还没有客户"}
          desc={keyword ? "换个关键词，或去 PC 端导入。" : "先在 PC 端导入客户，手机只做现场动作。"}
        />
      ) : (
        filtered.map((customer) => (
          <Card key={customer.id}>
            <View className="row">
              <View>
                <View className="list-title">{customer.name}</View>
                <View className="list-sub">
                  {customer.code} · {customer.contactName ?? "未填联系人"} ·{" "}
                  {maskPhone(customer.contactPhone)}
                </View>
              </View>
              <Badge
                tone={
                  customer.tier === "VIP" ? "warn" : customer.tier === "NEW" ? "info" : "neutral"
                }
              >
                {TIER_LABEL[customer.tier] ?? customer.tier}
              </Badge>
            </View>
            <View className="actions">
              <Text className="link" onClick={() => openCustomer(customer.id)}>
                客户 360
              </Text>
              <Text
                className="link"
                onClick={() => openQuote({ mode: "customer", customerId: customer.id })}
              >
                快速报价
              </Text>
            </View>
          </Card>
        ))
      )}
    </Page>
  );
}
