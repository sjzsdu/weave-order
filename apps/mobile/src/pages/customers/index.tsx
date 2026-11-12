import { View, Text } from "@tarojs/components";
import { useCustomers } from "@weave-order/core";
import { api } from "../../lib/runtime";

/** 客户：移动端只读列表 + 进入详情，不做批量导入（PC 独占）。 */
export default function CustomersPage() {
  const { data, isLoading } = useCustomers(api, 50);

  return (
    <View className="wrap">
      <View className="title">客户</View>
      <View className="muted">{isLoading ? "加载中…" : `${data?.length ?? 0} 位客户`}</View>
      {(data ?? []).map((customer) => (
        <View className="row" key={customer.id}>
          <View>
            <View>{customer.name}</View>
            <View className="muted">{customer.code}</View>
          </View>
          <Text className="amount">{customer.tier}</Text>
        </View>
      ))}
    </View>
  );
}
