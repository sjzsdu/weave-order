"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FabricSample, SampleImage, Unit } from "@weave-order/schema";
import { Badge, Button, MoneyText, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { canRetryImage, imageStatusBadges, thumbnailNote } from "@/sample-image-status";

const UNIT_LABEL: Record<Unit, string> = {
  meter: "米",
  kilogram: "公斤",
  yard: "码",
  piece: "件",
};

/**
 * 样品详情抽屉：大图轮播（按 sortOrder）、规格表、成本底线、以图找样、建寄样单。
 *
 * 成本底线由服务端按角色裁剪，这里不再判断角色 —— 拿到 null 就显示「不可见 / 未设置」。
 */
export function SampleDrawer({
  sampleId,
  onClose,
  onEdit,
}: {
  sampleId: string;
  onClose: () => void;
  onEdit: (sample: FabricSample) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [index, setIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [matches, setMatches] = useState<{ code: string; name: string; score: number }[]>([]);
  const [shipmentOpen, setShipmentOpen] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["sample", sampleId],
    queryFn: () => api.getSample(sampleId),
  });
  const sample = detail.data;

  useEffect(() => {
    setIndex(0);
    setMatches([]);
    setSearchError(null);
    setShipmentOpen(false);
    setRetryError(null);
  }, [sampleId]);

  const archive = useMutation({
    mutationFn: () => api.archiveSample(sampleId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["samples"] });
      await queryClient.invalidateQueries({ queryKey: ["sample", sampleId] });
      onClose();
    },
  });

  // 重试是同步动作：服务端跑完缩略图派生 / 向量索引才返回整份样品，
  // 因此这里直接把新读模型写回缓存，徽标立即反映真实结果。
  const retry = useMutation({
    mutationFn: (imageId: string) => api.retrySampleImage(sampleId, imageId),
    onMutate: () => setRetryError(null),
    onSuccess: (updated) => {
      queryClient.setQueryData(["sample", sampleId], updated);
      void queryClient.invalidateQueries({ queryKey: ["samples"] });
    },
    onError: (error) => {
      setRetryError(error instanceof Error ? error.message : "重试失败");
    },
  });

  const images = sample?.images ?? [];
  const current = images[Math.min(index, Math.max(images.length - 1, 0))] ?? null;

  const runImageSearch = async () => {
    if (!sample?.primaryImageUrl) {
      setSearchError("这个样品还没有图，先补图再以图找样。");
      return;
    }
    setSearching(true);
    setSearchError(null);
    setMatches([]);
    try {
      const result = await api.searchByImageUrl(sample.primaryImageUrl);
      if (!result.ok) {
        setSearchError(result.error?.message ?? "以图找样失败");
        return;
      }
      setMatches(
        result.data.matches.map((match) => ({
          code: match.sample.code,
          name: match.sample.name,
          score: match.score,
        })),
      );
      if (result.data.matches.length === 0) setSearchError("没有找到相似样品。");
    } catch (caught) {
      setSearchError(caught instanceof Error ? caught.message : "以图找样失败");
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink-900/30">
      <button
        type="button"
        aria-label="关闭详情"
        className="flex-1 cursor-default"
        onClick={onClose}
      />
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-line bg-surface shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-900">
              {sample?.name ?? "加载中…"}
            </p>
            <p className="text-xs text-ink-400">{sample?.code ?? sampleId}</p>
          </div>
          <div className="flex items-center gap-2">
            {sample && (
              <Button
                variant="ghost"
                className="min-h-9 px-3 text-xs"
                onClick={() => onEdit(sample)}
              >
                编辑
              </Button>
            )}
            <Button variant="ghost" className="min-h-9 px-3 text-xs" onClick={onClose}>
              关闭
            </Button>
          </div>
        </header>

        {detail.isLoading && <Spinner label="正在读取样品…" />}
        {detail.isError && (
          <p className="px-4 py-6 text-sm text-rose-700">
            {detail.error instanceof Error ? detail.error.message : "读取样品失败"}
          </p>
        )}

        {sample && (
          <div className="grid gap-4 px-4 py-4">
            <section className="grid gap-2">
              {current ? (
                <>
                  <img
                    src={current.detailUrl ?? current.url}
                    alt={`${sample.name} 第 ${index + 1} 张`}
                    className="aspect-square w-full rounded-lg border border-line bg-paper object-contain"
                  />
                  <ImageStatusPanel
                    image={current}
                    retrying={retry.isPending}
                    retryError={retryError}
                    onRetry={() => retry.mutate(current.id)}
                  />
                  {images.length > 1 && (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {images.map((image, position) => {
                        const note = thumbnailNote(image);
                        return (
                          <button
                            key={image.id}
                            type="button"
                            onClick={() => setIndex(position)}
                            className={cn(
                              "relative h-16 w-16 shrink-0 overflow-hidden rounded-md border",
                              position === index
                                ? "border-indigo-600 ring-1 ring-indigo-600/30"
                                : "border-line",
                            )}
                          >
                            <img
                              src={image.thumbUrl ?? image.url}
                              alt={`${sample.name} 缩略图 ${position + 1}`}
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                            {note && (
                              <span
                                title={
                                  note.tone === "danger"
                                    ? ((image.indexStatus === "failed"
                                        ? image.indexError
                                        : image.thumbError) ?? note.label)
                                    : note.label
                                }
                                className={cn(
                                  "absolute inset-x-0 bottom-0 truncate text-center text-[9px] leading-4 text-white",
                                  note.tone === "danger"
                                    ? "bg-vermilion-600/90"
                                    : "bg-amber-600/90",
                                )}
                              >
                                {note.label}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-paper text-sm text-ink-400">
                  <span>待补图</span>
                  <Button
                    variant="secondary"
                    className="min-h-9 px-3 text-xs"
                    onClick={() => onEdit(sample)}
                  >
                    上传样品图
                  </Button>
                </div>
              )}
            </section>

            <section className="overflow-hidden rounded-lg border border-line">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-line">
                  <Row label="编码" value={sample.code} />
                  <Row label="品名" value={sample.name} />
                  <Row label="成分" value={sample.composition ?? "—"} />
                  <Row label="品类" value={sample.category ?? "—"} />
                  <Row label="克重" value={sample.weight ?? "—"} />
                  <Row label="单位" value={UNIT_LABEL[sample.unit]} />
                  <Row
                    label="状态"
                    value={
                      <Badge tone={sample.status === "ACTIVE" ? "info" : "neutral"}>
                        {sample.status === "ACTIVE" ? "在售" : "已归档"}
                      </Badge>
                    }
                  />
                  <Row label="成本底线" value={<MoneyText money={sample.costFloor} />} />
                  <Row
                    label="创建时间"
                    value={new Date(sample.createdAt).toLocaleString("zh-CN")}
                  />
                  <Row label="图片" value={`${images.length} 张`} />
                </tbody>
              </table>
            </section>

            <section className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="min-h-9 px-3 text-xs"
                onClick={() => void runImageSearch()}
                disabled={searching}
              >
                {searching ? "找样中…" : "以图找样"}
              </Button>
              <Button
                variant="secondary"
                className="min-h-9 px-3 text-xs"
                onClick={() => setShipmentOpen((open) => !open)}
              >
                建寄样单
              </Button>
              {sample.status === "ACTIVE" && (
                <Button
                  variant="ghost"
                  className="min-h-9 px-3 text-xs text-rose-700"
                  onClick={() => {
                    if (window.confirm(`归档样品「${sample.name}」？归档后默认不出现在图墙。`)) {
                      archive.mutate();
                    }
                  }}
                  disabled={archive.isPending}
                >
                  归档
                </Button>
              )}
            </section>

            {(searchError || matches.length > 0) && (
              <section className="grid gap-2 rounded-lg border border-line bg-paper px-3 py-3">
                <p className="text-xs font-medium text-ink-700">以图找样结果</p>
                {searchError && <p className="text-xs text-ink-400">{searchError}</p>}
                {matches.map((match) => (
                  <div key={match.code} className="flex items-center justify-between text-xs">
                    <span className="text-ink-900">
                      {match.name} <span className="text-ink-400">· {match.code}</span>
                    </span>
                    <Badge tone="info">{(match.score * 100).toFixed(0)}%</Badge>
                  </div>
                ))}
                <p className="text-[10px] text-ink-400">
                  图像向量索引在 S4 落地；当前分数来自服务端可用的 embedding provider。
                </p>
              </section>
            )}

            {shipmentOpen && <ShipmentForm sample={sample} />}
          </div>
        )}
      </aside>
    </div>
  );
}

/**
 * 当前大图的处理状态：只说事实（索引中 / 索引失败 / 缩略图失败），
 * 失败时把服务端落库的原因原样显示，并给一个真正会重跑的「重试」。
 */
function ImageStatusPanel({
  image,
  retrying,
  retryError,
  onRetry,
}: {
  image: SampleImage;
  retrying: boolean;
  retryError: string | null;
  onRetry: () => void;
}) {
  const badges = imageStatusBadges(image);
  return (
    <div data-testid="image-status" className="flex flex-wrap items-center gap-2">
      {badges.length === 0 ? (
        <span className="text-xs text-ink-400">索引与缩略图都已就绪</span>
      ) : (
        badges.map((badge) => (
          <Badge key={badge.key} tone={badge.tone}>
            {badge.label}
          </Badge>
        ))
      )}
      {canRetryImage(image) && (
        <Button
          data-testid="image-retry"
          variant="secondary"
          className="min-h-8 px-3 text-xs"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? "重试中…" : "重试"}
        </Button>
      )}
      {badges
        .filter((badge) => badge.reason)
        .map((badge) => (
          <p key={badge.key} className="w-full text-xs text-rose-700">
            {badge.label}：{badge.reason}
          </p>
        ))}
      {retryError && <p className="w-full text-xs text-rose-700">{retryError}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr>
      <td className="w-28 bg-paper px-3 py-2 text-xs text-ink-400">{label}</td>
      <td className="px-3 py-2 text-ink-900">{value}</td>
    </tr>
  );
}

/** 建寄样单只产出 DRAFT：确认统一在审批窗口。 */
function ShipmentForm({ sample }: { sample: FabricSample }) {
  const api = useApi();
  const customers = useQuery({ queryKey: ["customers", 50], queryFn: () => api.listCustomers(50) });
  const [customerId, setCustomerId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; message: string } | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const value = Number(quantity);
      if (!Number.isFinite(value) || value <= 0) throw new Error("数量要大于 0");
      if (!customerId) throw new Error("先选客户");
      return api.createSampleShipment({
        customerId,
        items: [{ sampleId: sample.id, quantity: { value, unit: sample.unit } }],
      });
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setStatus({ tone: "error", message: result.error.message });
        return;
      }
      setStatus({
        tone: "ok",
        message: `已建寄样单草稿（${result.data.shipment.id.slice(0, 8)}…），去审批窗口确认后生效。`,
      });
    },
    onError: (error) => {
      setStatus({ tone: "error", message: error instanceof Error ? error.message : "建单失败" });
    },
  });

  const customerList = useMemo(() => customers.data ?? [], [customers.data]);

  return (
    <section className="grid gap-2 rounded-lg border border-line bg-paper px-3 py-3">
      <p className="text-xs font-medium text-ink-700">建寄样单（草稿）</p>
      <div className="flex flex-wrap gap-2">
        <select
          className="input min-w-40 flex-1"
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value)}
        >
          <option value="">选择客户</option>
          {customerList.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}（{customer.code}）
            </option>
          ))}
        </select>
        <input
          className="input w-24"
          inputMode="decimal"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          aria-label="数量"
        />
        <span className="self-center text-xs text-ink-400">{UNIT_LABEL[sample.unit]}</span>
        <Button
          className="min-h-9 px-3 text-xs"
          onClick={() => create.mutate()}
          disabled={create.isPending}
        >
          {create.isPending ? "创建中…" : "创建草稿"}
        </Button>
      </div>
      {status && (
        <p className={cn("text-xs", status.tone === "ok" ? "text-emerald-700" : "text-rose-700")}>
          {status.message}
        </p>
      )}
    </section>
  );
}
