import { Image, Text, View } from "@tarojs/components";
import { useDidShow } from "@tarojs/taro";
import { useCallback, useState } from "react";
import type { FabricSample } from "@weave-order/schema";
import { Badge, Button, Card, NavBar, Page, Sheet } from "../../components/ui";
import { api, IS_MOCK } from "../../lib/runtime";
import { openCamera, openQuote } from "../../lib/nav";
import { userFacingErrorMessage } from "../../lib/upload-failure";

type PageData = Awaited<ReturnType<typeof api.listSamplesPage>>;

/**
 * 移动端样品图墙：2 列缩略图 + 分页。
 * 无图不画伪色卡，统一显示「待补图」，让补图动作可见。
 */
export default function SamplesPage() {
  const [data, setData] = useState<PageData | null>(null);
  const [samples, setSamples] = useState<FabricSample[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FabricSample | null>(null);

  const load = useCallback(async (cursor: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listSamplesPage({ cursor, limit: 20, status: "ACTIVE" });
      setData(page);
      setSamples((current) => (cursor ? [...current, ...page.samples] : page.samples));
    } catch (caught) {
      // 技术原文只进日志：Zod 的 invalid_type 之类不能直接展示给用户。
      console.error("[samples] 加载失败", caught);
      setError(userFacingErrorMessage(caught, "加载样品失败，请重试"));
    } finally {
      setLoading(false);
    }
  }, []);

  useDidShow(() => {
    void load(null);
  });

  return (
    <Page>
      <NavBar title="样品库" />
      <View className="page-sub">拍照建样品；点开看规格。PC 上图墙更大、可以批量补规格。</View>

      <View className="actions" style={{ marginBottom: 12 }}>
        <Button variant="ghost" onClick={() => void load(null)} loading={loading}>
          刷新
        </Button>
        <Button onClick={() => openCamera("sample")}>拍照建样品</Button>
      </View>

      {IS_MOCK && (
        <Card className="card-flat">
          <View className="muted">演示模式只有示例样品，图片上传需切到真实后端。</View>
        </Card>
      )}

      {error && (
        <Card className="card-flat">
          <View style={{ color: "#b26a00" }}>{error}</View>
        </Card>
      )}

      {samples.length === 0 && !loading && !error ? (
        <Card className="card-flat">
          <View className="muted">还没有样品。点上方「拍照建样品」建第一个。</View>
        </Card>
      ) : (
        <View style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {samples.map((sample) => {
            const primary =
              sample.images?.find((image) => image.isPrimary) ?? sample.images?.[0] ?? null;
            const thumb = primary?.thumbUrl ?? primary?.url ?? sample.primaryImageUrl;
            return (
              <View
                key={sample.id}
                onClick={() => setSelected(sample)}
                style={{
                  width: "48%",
                  border: "1px solid #e7e2d7",
                  borderRadius: 10,
                  overflow: "hidden",
                  background: "#ffffff",
                }}
              >
                {thumb ? (
                  <Image
                    src={thumb}
                    mode="aspectFill"
                    style={{ width: "100%", height: 140, display: "block" }}
                  />
                ) : (
                  <View
                    className="tiny"
                    style={{
                      width: "100%",
                      height: 140,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "#faf8f3",
                      color: "#9a9385",
                    }}
                  >
                    待补图
                  </View>
                )}
                <View style={{ padding: "8px 10px" }}>
                  <View className="list-title">{sample.name}</View>
                  <View className="list-sub">
                    {sample.code} ·{" "}
                    {[sample.composition, sample.weight].filter(Boolean).join(" · ") || "规格未填"}
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {data && data.remaining > 0 && (
        <View className="actions" style={{ marginTop: 12 }}>
          <Button
            block
            variant="ghost"
            loading={loading}
            onClick={() => void load(data.nextCursor)}
          >
            还有 {data.remaining} 个，加载更多
          </Button>
        </View>
      )}

      <Sheet open={selected !== null} title="样品详情" onClose={() => setSelected(null)}>
        {selected && (
          <View>
            {(selected.images?.[0]?.url ?? selected.primaryImageUrl) ? (
              <Image
                src={selected.images?.[0]?.url ?? selected.primaryImageUrl ?? ""}
                mode="widthFix"
                style={{ width: "100%", borderRadius: 8 }}
              />
            ) : (
              <View
                style={{
                  width: "100%",
                  height: 160,
                  borderRadius: 8,
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
            <View className="label">编码</View>
            <Text>{selected.code}</Text>
            <View className="label">成分 / 克重</View>
            <Text>
              {[selected.composition ?? "成分未填", selected.weight ?? "克重未填"].join(" · ")}
            </Text>
            <View className="label">状态</View>
            <Badge tone={selected.status === "ACTIVE" ? "accent" : "warn"}>
              {selected.status === "ACTIVE" ? "在售" : "已归档"}
            </Badge>
            <View className="footnote">移动端只做看图与建样品；改规格、排序图片请到 PC 图墙。</View>
            <View className="actions">
              <Button
                block
                variant="ghost"
                onClick={() => {
                  const sampleId = selected.id;
                  setSelected(null);
                  // 带上 sampleId：报价页据此预填面料，否则样品库入口等于断链（WAN-160 A）。
                  openQuote({ sampleId, mode: "paste" });
                }}
              >
                用这个样品报价
              </Button>
            </View>
          </View>
        )}
      </Sheet>
    </Page>
  );
}
