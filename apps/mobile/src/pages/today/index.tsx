import { View, Text } from "@tarojs/components";
import { usePanorama } from "@weave-order/core";
import { api } from "../../lib/runtime";

/** 今日：只读聚合，回答「今天该做什么」。 */
export default function TodayPage() {
  const { data, isLoading, error } = usePanorama(api);

  return (
    <View className="wrap">
      <View className="title">今日</View>
      <View className="muted">
        {isLoading ? "加载中…" : error ? "暂时无法连接后端" : "只读汇总 · 由内核账本计算"}
      </View>

      {data && (
        <View style={{ marginTop: 24 }}>
          <View className="row">
            <Text>待审批</Text>
            <Text className="amount">{data.stats.pendingCount}</Text>
          </View>
          <View className="row">
            <Text>已发送报价</Text>
            <Text className="amount">{data.stats.sentQuoteCount}</Text>
          </View>
          <View className="row">
            <Text>客户 / 样品</Text>
            <Text className="amount">
              {data.stats.customerCount} / {data.stats.sampleCount}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}
