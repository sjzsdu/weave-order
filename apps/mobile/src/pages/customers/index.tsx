import { Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useMemo, useState } from "react";
import { Badge, Card, EmptyState, Loading, OfflineBanner, Page } from "../../components/ui";
import { useCustomerList, useOfflineBanner } from "../../lib/hooks";
import { maskPhone } from "../../lib/format";
import { followupSummary, needsFollowup, tierLabel } from "../../lib/customer-row";
import { enterQuote, openCustomer } from "../../routes";

/**
 * 客户列表。
 *
 * 顺序完全来自 `GET /api/customers?sort=followup`：待跟进优先 → 最近往来 → 等级。
 * 页面只做搜索收窄与动作，不做排序、不拿 100 条自己排——否则分页一开就错位。
 */
export default function CustomersPage() {
  const { data, isLoading } = useCustomerList("followup", 100);
  const banner = useOfflineBanner();
  const [keyword, setKeyword] = useState("");
  const [revealed, setRevealed] = useState<string[]>([]);

  const filtered = useMemo(() => {
    const list = data ?? [];
    const trimmed = keyword.trim().toLowerCase();
    if (!trimmed) return list;
    return list.filter(
      (customer) =>
        customer.name.toLowerCase().includes(trimmed) ||
        customer.code.toLowerCase().includes(trimmed) ||
        (customer.contactName ?? "").toLowerCase().includes(trimmed) ||
        (customer.contactWechat ?? "").toLowerCase().includes(trimmed),
    );
  }, [data, keyword]);

  const callCustomer = (id: string, phone: string | null) => {
    if (!phone) {
      void Taro.showToast({ title: "客户未留电话", icon: "none" });
      return;
    }
    if (phone.includes("*")) {
      void Taro.showToast({ title: "当前身份看不到完整号码", icon: "none" });
      return;
    }
    // 列表默认脱敏；点电话才把号码显示出来并调起拨号。
    setRevealed((current) => (current.includes(id) ? current : [...current, id]));
    void Taro.makePhoneCall({ phoneNumber: phone }).catch(() =>
      Taro.showToast({ title: "无法调起拨号，号码已显示", icon: "none" }),
    );
  };

  const openWechat = (wechat: string | null) => {
    if (!wechat) {
      void Taro.showToast({ title: "客户未留微信", icon: "none" });
      return;
    }
    void Taro.setClipboardData({ data: wechat }).then(() =>
      Taro.showToast({ title: "微信号已复制，去微信粘贴", icon: "none" }),
    );
  };

  return (
    <Page>
      <View className="page-title">客户</View>

      {banner.show && <OfflineBanner text={banner.text} />}

      <View className="search-sticky">
        <Input
          className="input"
          value={keyword}
          placeholder="搜客户名 / 编号 / 联系人 / 微信"
          onInput={(event) => setKeyword(event.detail.value)}
        />
      </View>
      <View className="footnote">
        共 {filtered.length} 位客户 · 默认待跟进优先 · 手机号默认脱敏
      </View>

      {isLoading && !data ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={keyword ? "没有匹配的客户" : "还没有客户"}
          desc={
            keyword ? "换个关键词，或去 PC 端导入。" : "先在 PC 端导入客户，手机上就能直接报价。"
          }
        />
      ) : (
        filtered.map((customer) => {
          const phone = customer.contactPhone;
          const showPhone = revealed.includes(customer.id);
          return (
            <Card key={customer.id} onClick={() => openCustomer(customer.id)}>
              <View className="row">
                <View className="customer-main">
                  <View className="list-title">{customer.name}</View>
                  <View className="list-sub">
                    {customer.code} · {showPhone ? phone : maskPhone(phone)}
                  </View>
                </View>
                <Badge
                  tone={
                    customer.tier === "VIP" ? "warn" : customer.tier === "NEW" ? "info" : "neutral"
                  }
                >
                  {tierLabel(customer.tier)}
                </Badge>
              </View>

              {/*
               * 这一行同时承担原来的「360」链接：文案直接说清为什么该点进去，
               * 不再出现没有信息量的「客户 360」。
               */}
              <View className="customer-money">
                <Text
                  className={needsFollowup(customer) ? "link customer-link" : "muted customer-link"}
                  onClick={() => openCustomer(customer.id)}
                >
                  {followupSummary(customer)}
                </Text>
                {needsFollowup(customer) && <Badge tone="warn">待跟进</Badge>}
              </View>

              <View className="actions customer-actions">
                <View
                  className="btn btn-ghost btn-small"
                  ariaRole="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openWechat(customer.contactWechat);
                  }}
                >
                  微信
                </View>
                <View
                  className="btn btn-ghost btn-small"
                  ariaRole="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    callCustomer(customer.id, phone);
                  }}
                >
                  电话
                </View>
                <View
                  className="btn btn-primary btn-small"
                  ariaRole="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    enterQuote({ mode: "customer", customerId: customer.id });
                  }}
                >
                  报价
                </View>
              </View>
            </Card>
          );
        })
      )}
    </Page>
  );
}
