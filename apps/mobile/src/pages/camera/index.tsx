import { Image, Input, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@weave-order/core";
import type { ImageMatch } from "@weave-order/schema";
import { Badge, Button, Card, Page, SectionTitle } from "../../components/ui";
import { useNetworkStatus } from "../../lib/hooks";
import {
  compressImage,
  persistImage,
  uploadImage,
  uploadImageToPresignedUrl,
} from "../../lib/media";
import type { CompressedImage } from "../../lib/media";
import { api, mediaStore, offlineQueue, prefs } from "../../lib/runtime";
import { enqueueOperation } from "../../lib/offline";
import { openQuote } from "../../lib/nav";
import {
  buildSampleSaveFailureMessage,
  isMediaUploadError,
  uploadFailureMessage,
  userFacingErrorMessage,
} from "../../lib/upload-failure";

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
  const queryClient = useQueryClient();
  const network = useNetworkStatus();
  const [mode, setMode] = useState<Mode>("find");
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<CompressedImage | null>(null);
  const [matches, setMatches] = useState<ImageMatch[]>([]);
  // 找样结果的元信息：mode=caption 或 semantic=false 时前端文案必须不同，不能假装是真图搜图。
  const [findMeta, setFindMeta] = useState<{
    mode: "image" | "caption";
    semantic: boolean;
    indexing: number;
  } | null>(null);
  const [resultText, setResultText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tracking, setTracking] = useState("");
  const [note, setNote] = useState("");
  // 「建样品」：拍完只填最少字段，其余可之后在图墙补。
  const [sampleName, setSampleName] = useState("");
  const [sampleComposition, setSampleComposition] = useState("");
  const [sampleWeight, setSampleWeight] = useState("");
  const [savingSample, setSavingSample] = useState(false);

  useDidShow(() => {
    const pending = prefs.takeCameraMode();
    if (pending && MODES.some((entry) => entry.id === pending)) setMode(pending as Mode);
  });

  const current = MODES.find((entry) => entry.id === mode) ?? MODES[0]!;

  const pickImage = async (source: "camera" | "album") => {
    setError(null);
    setMatches([]);
    setFindMeta(null);
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
      else if (mode === "sample") {
        // 拍完停在表单：品名/成分/克重填好再保存，避免“拍完就丢”。
        setResultText(null);
      } else if (mode !== "waybill") await runProof(compressed, mode);
    } catch (caught) {
      setError(
        caught instanceof Error && /cancel/i.test(caught.message)
          ? "已取消选择照片"
          : userFacingErrorMessage(caught, "图片处理失败，请重试"),
      );
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
      const result: Awaited<ReturnType<typeof api.searchByImageUrl>> =
        await api.searchByImageUrl(url);
      if (!result.ok) {
        setError(result.error?.message ?? "以图找样失败");
        return;
      }
      setMatches(result.data.matches);
      setFindMeta({
        mode: result.data.mode ?? "image",
        semantic: result.data.semantic ?? true,
        indexing: result.data.indexing ?? 0,
      });
      if (result.data.matches.length === 0) {
        // 「没索引完」和「真没有」是两件事，不能都显示成「没有匹配」。
        setError(
          (result.data.indexing ?? 0) > 0
            ? `还有 ${result.data.indexing} 张样品图在建立索引，稍后重试；也可以先改用规格找样。`
            : "没有匹配的面料。重拍一张光线更好的，或改用规格找样。",
        );
      }
    } catch (caught) {
      setError(userFacingErrorMessage(caught, "找样失败，请重试"));
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
        // 在线却失败（CORS / 断网 / 存储拒绝）不能当成「离线待上传」：
        // 队列只在真正离线时启用，否则用户会误以为照片已经安全落盘。
        const message = isMediaUploadError(caught)
          ? `${caught.message} 照片还在本页，可重试。`
          : caught instanceof TypeError
            ? "网络连接失败，照片未提交，请检查网络后重试。"
            : `${userFacingErrorMessage(caught, "上传或记录失败")}，请重试。`;
        setError(message);
        return;
      }
    }
    // 只有确认离线才入队：照片落 IndexedDB，联网后按时间序补传。
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

  /** 建样品：先建行 → 图片直传 → confirm 挂图。任何一步失败都显式报错。 */
  const saveSample = async () => {
    if (!image || savingSample) return;
    if (!sampleName.trim()) {
      setError("品名必填（其余字段可以之后补）");
      return;
    }
    if (!network.online) {
      setError("建样品需要联网；图片已留在本页，联网后重试。");
      return;
    }
    setSavingSample(true);
    setError(null);
    setResultText(null);
    try {
      const code = `SP-${Date.now().toString(36).toUpperCase()}`;
      const created = await api.createSample({
        code,
        name: sampleName.trim(),
        composition: sampleComposition.trim() || null,
        weight: sampleWeight.trim() || null,
        unit: "meter",
      });
      try {
        const presigned = await api.presignImage({
          mimeType: image.mimeType,
          byteSize: image.byteSize,
          sampleId: created.id,
        });
        await uploadImageToPresignedUrl(image, presigned, image.mimeType);
        await api.confirmImage({
          objectKey: presigned.objectKey,
          sortOrder: 0,
          width: image.width,
          height: image.height,
        });
      } catch (caught) {
        // 样品记录已经建出来了：传图失败就撤销它，避免留下「无图样品」脏数据。
        const rolledBack = await api
          .archiveSample(created.id)
          .then(() => true)
          .catch(() => false);
        const reason =
          caught instanceof ApiError
            ? caught.message
            : uploadFailureMessage(caught, "图片上传失败，请重试");
        setError(
          buildSampleSaveFailureMessage({
            reason,
            rolledBack,
            name: created.name,
            code,
          }),
        );
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["samples"] });
      setResultText(`已建样品「${created.name}」（${code}），图墙里可以补规格。`);
      setSampleName("");
      setSampleComposition("");
      setSampleWeight("");
      setImage(null);
      void Taro.showToast({ title: "样品已保存", icon: "success" });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : caught instanceof TypeError
            ? "网络连接失败，请检查网络后重试（本次未创建样品）"
            : userFacingErrorMessage(caught, "建样品失败"),
      );
    } finally {
      setSavingSample(false);
    }
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
          {mode === "sample" && (
            <View>
              <View className="label">品名（必填）</View>
              <Input
                className="input"
                value={sampleName}
                placeholder="如 32S 精梳棉汗布"
                onInput={(event) => setSampleName(event.detail.value)}
              />
              <View className="label">成分</View>
              <Input
                className="input"
                value={sampleComposition}
                placeholder="如 100% 棉"
                onInput={(event) => setSampleComposition(event.detail.value)}
              />
              <View className="label">克重</View>
              <Input
                className="input"
                value={sampleWeight}
                placeholder="如 220g/m²"
                onInput={(event) => setSampleWeight(event.detail.value)}
              />
              <View className="actions">
                <Button onClick={() => void saveSample()} loading={savingSample}>
                  保存到样品库
                </Button>
              </View>
              <View className="footnote">编码自动生成；其余规格可在 PC 图墙继续补。</View>
            </View>
          )}
        </Card>
      )}

      {resultText && (
        <Card className="card-flat">
          <View className="muted">{resultText}</View>
        </Card>
      )}
      {error && (
        <Card className="card-flat">
          <View className="warn-text">{error}</View>
        </Card>
      )}

      {mode === "find" && findMeta && (findMeta.mode === "caption" || !findMeta.semantic) && (
        <Card className="card-flat">
          <Badge tone="warn">{findMeta.mode === "caption" ? "按图像描述检索" : "演示模式"}</Badge>
          <View className="muted" style={{ marginTop: 8 }}>
            {findMeta.mode === "caption"
              ? "这次按图片描述找相似面料，结果仅供参考。"
              : "当前是演示模式，结果只用于体验，不代表真实相似度。"}
          </View>
        </Card>
      )}

      {mode === "find" && matches.length > 0 && (
        <View>
          <SectionTitle
            title="候选面料"
            hint={`${matches.length} 个 · 点一个直接报价${findMeta && findMeta.indexing > 0 ? ` · 还有 ${findMeta.indexing} 张图索引中` : ""}`}
          />
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
                <View className="row" style={{ gap: 8, alignItems: "center" }}>
                  {(match.matchedImageUrl ?? match.sample.primaryImageUrl) ? (
                    <Image
                      // 优先显示命中的那张图：让用户看到「你拍的这张最像这个角度的这张图」。
                      src={(match.matchedImageUrl ?? match.sample.primaryImageUrl)!}
                      mode="aspectFill"
                      style={{ width: 44, height: 44, borderRadius: 6 }}
                    />
                  ) : (
                    <View
                      className="tiny"
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 6,
                        border: "1px dashed #d8d3c8",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#9a9385",
                      }}
                    >
                      待补图
                    </View>
                  )}
                  <Badge tone="accent">相似 {(match.score * 100).toFixed(0)}%</Badge>
                </View>
              </View>
              {match.reasons && match.reasons.length > 0 && (
                <View className="list-sub" style={{ marginTop: 6 }}>
                  {match.reasons.join(" · ")}
                </View>
              )}
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
