import { View, Text, Image } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";

/**
 * 相机找样：拍照 → 压缩（长边 1600 / ≤1MB）→ 后续走 T-001 以图搜图。
 * 图片禁止 base64 走 JSON，正式接口用对象存储直传；当前先做端侧能力骨架。
 */
export default function CameraPage() {
  const [preview, setPreview] = useState<string | null>(null);

  const takePhoto = async () => {
    try {
      const result = await Taro.chooseImage({
        count: 1,
        sizeType: ["compressed"],
        sourceType: ["camera", "album"],
      });
      const path = result.tempFilePaths[0];
      if (path) setPreview(path);
    } catch {
      await Taro.showToast({ title: "未选择图片", icon: "none" });
    }
  };

  return (
    <View className="wrap">
      <View className="title">拍照找样</View>
      <View className="muted">色卡屏幕色仅供参考，最终以大货样为准。</View>
      <View className="row" style={{ marginTop: 24 }} onClick={() => void takePhoto()}>
        <Text>拍照 / 从相册选择</Text>
        <Text className="action">打开相机</Text>
      </View>
      {preview && (
        <Image src={preview} mode="widthFix" style={{ width: "100%", borderRadius: 16 }} />
      )}
      <View className="muted" style={{ marginTop: 16 }}>
        图片直传对象存储后调用 T-001；当前 Track D 接入前仅保留端侧骨架。
      </View>
    </View>
  );
}
