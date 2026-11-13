import { Image, Input, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useState } from "react";
import { ApiError } from "@weave-order/core";
import type { ImageMatch, T001SearchFabricByImageResult } from "@weave-order/schema";
import { Badge, Button, Card, Page, SectionTitle } from "../../components/ui";
import { useNetworkStatus } from "../../lib/hooks";
import { compressImage, persistImage, uploadImage } from "../../lib/media";
import type { CompressedImage } from "../../lib/media";
import { api, IS_MOCK, mediaStore, offlineQueue, prefs } from "../../lib/runtime";
import { enqueueOperation } from "../../lib/offline";
import { openQuote } from "../../lib/nav";

type Mode = "find" | "waybill" | "signature" | "cargo" | "sample" | "receipt";

const MODES: Array<{ id: Mode; icon: string; label: string; desc: string }> = [
  { id: "find", icon: "🔎", label: "找样", desc: "拍布 / 相册找同款" },
  { id: "waybill", icon: "📦", label: "扫运单", desc: "扫码录运单号" },
  { id: "signature", icon: "✍️", label: "拍签收", desc: "签收单回传" },
  { id: "cargo", icon: "🏭", label: "拍大货", desc: "生产进度" },
  { id: "sample", icon: "🧵", label: "建样品", desc: "拍布建样" },
  { id: "receipt", icon: "💳", label: "拍回款", desc: "凭证回传" },
];

const PROOF_KIND: Record<
  Exclude<Mode, "find" | "waybill">,
  "SIGNATURE" | "CARGO" | "SAMPLE" | "RECEIPT"
> = {
  signature: "SIGNATURE",
  cargo: "CARGO",
  sample: "SAMPLE",
  receipt: "RECEIPT",
};

export default function CameraPage() {
  const network = useNetworkStatus();
  const [mode, setMode] = useState<Mode>("find");
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<CompressedImage | null>(null);
  const [matches, setMatches] = useState<ImageMatch[]>([]);
  const [resultText, setResultText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tracking, setTracking] = useState("");
  const [note, setNote] = useState("");

  useDidShow(() => {
    const pending = prefs.takeCameraMode();
    if (pending && MODES.some((entry) => entry.id === pending)) setMode(pending as Mode);
  });

  const current = MODES.find((entry) => entry.id === mode) ?? MODES[0]!;

  const pickImage = async (source: "camera" | "album") => {
    setError(null);
    setMatches([]);
    setResultText(null);
    try {
      const picked = await Taro.chooseImage({
        count: 1,
        sizeType: ["original", "compressed"],
        sourceType: [source],
      });
      const path = picked.tempFilePaths[0];
      if (!path) return;
      setBusy(true);
      const compressed = await compressImage(path);
      if (compressed.byteSize > 1024 * 1024) {
        setError("压缩后仍超过 1MB，请换一张或裁剪后重试。");
        return;
      }
      setImage(compressed);
      if (mode === "find") await runFind(compressed);
      else if (mode !== "waybill") await runProof(compressed, mode);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片处理失败");
    } finally {
      setBusy(false);
    }
  };

  const runFind = async (compressed: CompressedImage) => {
    if (!network.online) {
      setError("找样需要联网；照片已留在本页，可稍后重试。");
      return;
    }
    try {
      const url = await uploadImage(compressed, api);
      const result: T001SearchFabricByImageResult = await api.searchByImageUrl(url);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setMatches(result.data.matches);
      if (result.data.matches.length === 0)
        setError("没有匹配的面料。重拍一张光线更好的，或改用规格找样。");
    } catch (caught) {
      setError(
        IS_MOCK
          ? caught instanceof Error
            ? caught.message
            : "找样失败"
          : "以图找样需要后端支持 imageUrl（T-001 契约当前只收 base64，与移动端禁止 base64 冲突）。",
      );
    }
  };

  const runProof = async (
    compressed: CompressedImage,
    proofMode: Exclude<Mode, "find" | "waybill">,
  ) => {
    const kind = PROOF_KIND[proofMode];
    if (network.online) {
      try {
        const imageUrl = await uploadImage(compressed, api);
        await api.recordProof({
          kind,
          imageUrl,
          ...(tracking ? { trackingNumber: tracking } : {}),
          ...(note ? { note } : {}),
        });
        setResultText("已上传并记录（图片直传对象存储，未走 base64 JSON）");
        return;
      } catch (caught) {
        if (caught instanceof ApiError) {
          setError(caught.message);
          return;
        }
        // 网络 / 上传失败落离线队列，照片存本地，恢复后按时间序补传。
      }
    }
    const mediaKey = await persistImage(compressed, mediaStore);
    await enqueueOperation(offlineQueue, {
      kind: "shipment.proof",
      opId: `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      payload: {
        kind,
        mediaKey,
        ...(tracking ? { trackingNumber: tracking } : {}),
        ...(note ? { note } : {}),
      },
    });
    setResultText(`已存本地（${(compressed.byteSize / 1024).toFixed(0)}KB）· 联网后自动上传`);
  };

  const scanWaybill = async () => {
    setError(null);
    try {
      if (process.env.TARO_ENV === "weapp") {
        const result = await Taro.scanCode({ scanType: ["barCode", "qrCode"] });
        setTracking(result.result);
        setResultText(`运单号：${result.result}`);
        return;
      }
      const options = {
        title: "录入运单号",
        editable: true,
        placeholderText: "例如 SF1234567890",
      } as unknown as Parameters<typeof Taro.showModal>[0];
      const result = (await Taro.showModal(options)) as unknown as {
        confirm: boolean;
        content?: string;
      };
      if (result.confirm && result.content) {
        setTracking(result.content);
        setResultText(`运单号：${result.content}（已在本地暂存，接入 Track A 后提交）`);
      }
    } catch {
      setError("扫码失败，请手动输入运单号");
    }
  };

  return (
    <Page>
      <View className="page-title">相机</View>
      <View className="page-sub">现场能力入口：能拍就不填。色卡屏幕色仅供参考，以实物为准。</View>

      <View className="grid-3">
        {MODES.map((entry) => (
          <View
            key={entry.id}
            className={`tile${mode === entry.id ? " tile-active" : ""}`}
            onClick={() => {
              setMode(entry.id);
              setMatches([]);
              setResultText(null);
              setError(null);
            }}
          >
            <View className="tile-icon">{entry.icon}</View>
            <View className="tile-label">{entry.label}</View>
          </View>
        ))}
      </View>

      <Card className="card-flat" style={{ marginTop: 16 }}>
        <View className="row">
          <View>
            <View className="list-title">
              {current.icon} {current.label}
            </View>
            <View className="list-sub">{current.desc}</View>
          </View>
          <Badge tone={network.online ? "accent" : "warn"}>
            {network.online ? "在线" : "离线"}
          </Badge>
        </View>

        {mode === "waybill" ? (
          <View className="actions">
            <Button block onClick={() => void scanWaybill()}>
              扫码 / 录入运单号
            </Button>
          </View>
        ) : (
          <View className="actions">
            <Button variant="ghost" onClick={() => void pickImage("album")} disabled={busy}>
              从相册
            </Button>
            <Button onClick={() => void pickImage("camera")} loading={busy}>
              打开相机
            </Button>
          </View>
        )}

        <View className="label">备注 / 运单号</View>
        <Input
          className="input"
          value={tracking}
          placeholder="运单号（可选）"
          onInput={(event) => setTracking(event.detail.value)}
        />
        <View style={{ marginTop: 12 }}>
          <Input
            className="input"
            value={note}
            placeholder="一句说明（可选）"
            onInput={(event) => setNote(event.detail.value)}
          />
        </View>
      </Card>

      {image && (
        <Card>
          <Image className="media-preview" src={image.path} mode="widthFix" />
          <View className="row" style={{ marginTop: 12 }}>
            <Text className="tiny">
              {image.width}×{image.height} · {(image.byteSize / 1024).toFixed(0)}KB ·{" "}
              {image.mimeType}
            </Text>
            <Badge tone={image.byteSize <= 1024 * 1024 ? "accent" : "danger"}>
              长边 ≤1600 · ≤1MB
            </Badge>
          </View>
        </Card>
      )}

      {resultText && (
        <Card className="card-flat">
          <View className="muted">{resultText}</View>
        </Card>
      )}
      {error && (
        <Card className="card-flat">
          <View style={{ color: "#b26a00", fontSize: 24 }}>{error}</View>
        </Card>
      )}

      {mode === "find" && matches.length > 0 && (
        <View>
          <SectionTitle title="候选面料" hint={`${matches.length} 个 · 点一个直接报价`} />
          {matches.map((match) => (
            <Card key={match.sample.id}>
              <View className="row">
                <View>
                  <View className="list-title">{match.sample.name}</View>
                  <View className="list-sub">
                    {match.sample.code} · {match.sample.composition ?? "成分未填"} ·{" "}
                    {match.sample.weight ?? ""}
                  </View>
                </View>
                <Badge tone="accent">相似 {(match.score * 100).toFixed(0)}%</Badge>
              </View>
              <View className="actions">
                <Button
                  small
                  onClick={() => openQuote({ sampleId: match.sample.id, mode: "paste" })}
                >
                  用这个报价
                </Button>
              </View>
            </Card>
          ))}
        </View>
      )}

      <View className="footnote">
        图片先压缩（长边 1600px / ≤1MB）再直传对象存储；离线时照片存本地队列，联网后按时间序提交。
        扫箱唛重打与蓝牙标签在「更多」。
      </View>
    </Page>
  );
}
