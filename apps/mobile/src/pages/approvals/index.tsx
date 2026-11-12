import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useApprovals, useDecideApproval } from "@weave-order/core";
import type { ApprovalItem } from "@weave-order/schema";
import { api } from "../../lib/runtime";

/**
 * 审批：移动端只做「批 / 驳回」，不做批量。
 * 失败不乐观更新；冲突留给人工确认。
 */
export default function ApprovalsPage() {
  const { data, isLoading, refetch } = useApprovals(api);
  const decide = useDecideApproval(api);

  const onDecide = async (item: ApprovalItem, decision: "APPROVE" | "REJECT") => {
    const result = await decide.mutateAsync({
      id: item.id,
      kind: item.kind,
      decision,
      note: decision === "REJECT" ? "移动端快速驳回" : undefined,
    });
    if (!result.ok) {
      await Taro.showToast({ title: result.error.message, icon: "none" });
      return;
    }
    await Taro.showToast({ title: decision === "APPROVE" ? "已批准" : "已驳回", icon: "success" });
    await refetch();
  };

  return (
    <View className="wrap">
      <View className="title">审批</View>
      <View className="muted">
        {isLoading ? "加载中…" : `${data?.items.length ?? 0} 条待处理 · 金额与校验均由服务端完成`}
      </View>

      {(data?.items ?? []).map((item: ApprovalItem) => (
        <View className="row draft" key={item.id} style={{ flexDirection: "column" }}>
          <View style={{ width: "100%", display: "flex", justifyContent: "space-between" }}>
            <Text>{item.title}</Text>
            <Text className="amount">{item.summary}</Text>
          </View>
          <View style={{ display: "flex", gap: 16, marginTop: 16 }}>
            <Text className="action" onClick={() => void onDecide(item, "APPROVE")}>
              批准
            </Text>
            <Text
              className="action"
              style={{ background: "#b3261e" }}
              onClick={() => void onDecide(item, "REJECT")}
            >
              驳回
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}
