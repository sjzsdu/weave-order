import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import { offlineQueue } from "../../lib/runtime";

/** 更多：账户 / 离线队列 / 隐私说明。权限配置与模板编辑不在移动端。 */
export default function MorePage() {
  const [queued, setQueued] = useState(0);

  useEffect(() => {
    void offlineQueue.list().then((items) => setQueued(items.length));
  }, []);

  return (
    <View className="wrap">
      <View className="title">更多</View>
      <View className="muted">移动端不提供批量导入、权限配置与模板编辑。</View>

      <View className="row" style={{ marginTop: 24 }}>
        <Text>离线待提交</Text>
        <Text className="amount">{queued}</Text>
      </View>
      <View className="row">
        <Text>端类型</Text>
        <Text className="amount">{process.env.TARO_ENV}</Text>
      </View>
      <View
        className="row"
        onClick={() =>
          void Taro.showModal({
            title: "隐私",
            content: "图片与客户数据不上传到第三方模型；敏感字段出网前脱敏。",
          })
        }
      >
        <Text>隐私与数据说明</Text>
        <Text className="action">查看</Text>
      </View>
    </View>
  );
}
