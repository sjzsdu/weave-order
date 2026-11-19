"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { FabricSample, FieldKey, Unit } from "@weave-order/schema";
import { Badge, Button, ComboBox, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { FieldOptionsManager, useFieldOptions } from "@/field-options-manager";
import { compressImageFile, uploadToPresignedUrl } from "@/image-compress";
import type { CompressedImage } from "@/image-compress";

interface DraftImage {
  /** 已有图片的 ID；新图上传成功后才回填。 */
  id: string | null;
  previewUrl: string;
  blob?: Blob;
  width?: number;
  height?: number;
  byteSize?: number;
}

const UNIT_LABEL: Record<Unit, string> = {
  meter: "米",
  kilogram: "公斤",
  yard: "码",
  piece: "件",
};

function suggestCode(): string {
  return `SP-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

/** 只释放本地 objectURL；已有图片的远程 URL 不能 revoke。 */
function revokePreview(image: DraftImage): void {
  if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
}

/**
 * 新建 / 编辑样品。图片在浏览器里先压到长边 ≤1600 / ≤1MB，再直传对象存储；
 * 样品行与图片行的写入都走内核（`POST/PATCH /api/samples`），前端不拼 objectKey。
 */
export function SampleEditor({
  open,
  sample,
  onClose,
  onSaved,
}: {
  open: boolean;
  sample: FabricSample | null;
  onClose: () => void;
  /** 保存成功后回传刚写库的那条样品，调用方据此给「已建 / 已更新 + 下一步」的反馈。 */
  onSaved: (saved: FabricSample, meta: { created: boolean }) => void;
}) {
  const api = useApi();
  const isEdit = sample !== null;
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [composition, setComposition] = useState("");
  const [category, setCategory] = useState("");
  const [weight, setWeight] = useState("");
  const [unit, setUnit] = useState<Unit>("meter");
  const [costFloorYuan, setCostFloorYuan] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [primaryIndex, setPrimaryIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manageField, setManageField] = useState<FieldKey | null>(null);
  const compositionOptions = useFieldOptions("sample.composition");
  const categoryOptions = useFieldOptions("sample.category");

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setCode(sample?.code ?? suggestCode());
    setName(sample?.name ?? "");
    setComposition(sample?.composition ?? "");
    setCategory(sample?.category ?? "");
    setWeight(sample?.weight ?? "");
    setUnit(sample?.unit ?? "meter");
    setCostFloorYuan(sample?.costFloor ? (sample.costFloor.amount / 100).toFixed(2) : "");
    const existing = (sample?.images ?? []).map((image) => ({
      id: image.id,
      previewUrl: image.thumbUrl ?? image.url,
    }));
    setImages(existing);
    const primary = (sample?.images ?? []).findIndex((image) => image.isPrimary);
    setPrimaryIndex(primary >= 0 ? primary : 0);
  }, [open, sample]);

  const costFloor = useMemo(() => {
    if (costFloorYuan.trim() === "") return null;
    const yuan = Number(costFloorYuan);
    if (!Number.isFinite(yuan) || yuan < 0) return undefined;
    return { amount: Math.round(yuan * 100), currency: "CNY" as const };
  }, [costFloorYuan]);

  if (!open) return null;

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const next: DraftImage[] = [];
      for (const file of Array.from(files).slice(0, 20)) {
        if (!file.type.startsWith("image/")) continue;
        const compressed: CompressedImage = await compressImageFile(file);
        next.push({
          id: null,
          previewUrl: compressed.previewUrl,
          blob: compressed.blob,
          width: compressed.width,
          height: compressed.height,
          byteSize: compressed.byteSize,
        });
      }
      const merged = [...images, ...next];
      // 超过 20 张的新图直接丢弃，同时释放它们的预览 URL，避免累积。
      merged.slice(20).forEach(revokePreview);
      setImages(merged.slice(0, 20));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片处理失败");
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= images.length) return;
    setImages((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (item) next.splice(target, 0, item);
      return next;
    });
    setPrimaryIndex((current) => {
      if (current === index) return target;
      if (current === target) return index;
      return current;
    });
  };

  const remove = (index: number) => {
    const removed = images[index];
    if (removed) revokePreview(removed);
    setImages((current) => current.filter((_, position) => position !== index));
    setPrimaryIndex((current) => {
      if (index === current) return 0;
      return index < current ? current - 1 : current;
    });
  };

  const handleClose = () => {
    images.forEach(revokePreview);
    onClose();
  };

  const save = async () => {
    setError(null);
    if (!code.trim()) return setError("编码必填");
    if (!name.trim()) return setError("品名必填");
    if (costFloor === undefined) return setError("成本底线必须是数字（元）");
    setBusy(true);
    let created: FabricSample | null = null;
    // 编辑走 PATCH，返回的是保存后的实体；新建则复用刚创建的那条。
    let saved: FabricSample | null = null;
    try {
      const base: FabricSample =
        isEdit && sample
          ? sample
          : await api.createSample({
              code: code.trim(),
              name: name.trim(),
              composition: composition.trim() || null,
              category: category.trim() || null,
              weight: weight.trim() || null,
              unit,
              costFloor,
            });
      created = isEdit ? null : base;

      // 新图：服务端生成 key → 浏览器直传 → confirm 挂到样品。
      const orderedIds: string[] = [];
      for (const [index, image] of images.entries()) {
        if (image.id) {
          orderedIds.push(image.id);
          continue;
        }
        if (!image.blob) continue;
        const presigned = await api.presignImage({
          mimeType: "image/jpeg",
          byteSize: image.blob.size,
          sampleId: base.id,
        });
        await uploadToPresignedUrl(presigned.uploadUrl, presigned.headers, image.blob);
        const confirmed = await api.confirmImage({
          objectKey: presigned.objectKey,
          sortOrder: index,
          ...(image.width ? { width: image.width } : {}),
          ...(image.height ? { height: image.height } : {}),
        });
        orderedIds.push(confirmed.id);
        image.id = confirmed.id;
      }

      const primaryImageId =
        orderedIds.length > 0 ? orderedIds[Math.min(primaryIndex, orderedIds.length - 1)] : null;
      if (isEdit) {
        // 用服务端回的实体，不用编辑前的 base：否则失败/编辑态会把旧品名喂给 toast。
        saved = await api.updateSample(base.id, {
          code: code.trim(),
          name: name.trim(),
          composition: composition.trim() || null,
          category: category.trim() || null,
          weight: weight.trim() || null,
          unit,
          costFloor,
          // 整组替换：即使是「全部删掉」也要把空数组发出去，否则删除不会落库。
          imageIds: orderedIds,
          primaryImageId,
        });
      } else if (orderedIds.length > 0) {
        await api.updateSample(base.id, { imageIds: orderedIds, primaryImageId });
      }
      onSaved(saved ?? base, { created: !isEdit });
      handleClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "保存失败";
      setError(
        created
          ? `样品「${created.name}」已创建，但图片上传失败：${message}。可在图墙里点这张卡片补图。`
          : message,
      );
      if (created) onSaved(created, { created: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4 md:p-8">
      <div className="w-full max-w-3xl rounded-xl border border-line bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-ink-900">
              {isEdit ? "编辑样品" : "新建样品"}
            </h2>
            <p className="text-xs text-ink-400">图片上传前会自动压到长边 1600px / 1MB 以内</p>
          </div>
          <Button variant="ghost" onClick={handleClose} disabled={busy}>
            关闭
          </Button>
        </header>

        <div className="grid gap-4 px-5 py-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="编码 *">
              <input
                className="input"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="如 FM-220"
              />
            </Field>
            <Field label="品名 *">
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="如 32S 精梳棉汗布"
              />
            </Field>
            <Field label="成分">
              <ComboBox
                value={composition}
                onChange={setComposition}
                options={compositionOptions.options
                  .filter((option) => option.active)
                  .map((option) => ({ value: option.code, label: option.label }))}
                loading={compositionOptions.loading}
                loadError={compositionOptions.error}
                onSaveAsOption={async (label) => {
                  try {
                    await api.createFieldOption("sample.composition", label);
                    await compositionOptions.reload();
                  } catch (caught) {
                    setError(caught instanceof Error ? caught.message : "保存成分选项失败");
                  }
                }}
                footer={
                  <button
                    type="button"
                    className="text-xs text-indigo-700 hover:underline"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setManageField("sample.composition")}
                  >
                    管理成分
                  </button>
                }
                placeholder="如 100% 棉"
              />
            </Field>
            <Field label="品类">
              <ComboBox
                value={category}
                onChange={setCategory}
                options={categoryOptions.options
                  .filter((option) => option.active)
                  .map((option) => ({ value: option.code, label: option.label }))}
                loading={categoryOptions.loading}
                loadError={categoryOptions.error}
                onSaveAsOption={async (label) => {
                  try {
                    await api.createFieldOption("sample.category", label);
                    await categoryOptions.reload();
                  } catch (caught) {
                    setError(caught instanceof Error ? caught.message : "保存品类选项失败");
                  }
                }}
                footer={
                  <button
                    type="button"
                    className="text-xs text-indigo-700 hover:underline"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setManageField("sample.category")}
                  >
                    管理品类
                  </button>
                }
                placeholder="如 针织 / 梭织"
              />
            </Field>
            <Field label="克重">
              <input
                className="input"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                placeholder="如 220g/m²"
              />
            </Field>
            <Field label="单位与成本底线（元）">
              <div className="flex gap-2">
                <select
                  className="input w-28"
                  value={unit}
                  onChange={(event) => setUnit(event.target.value as Unit)}
                >
                  {Object.entries(UNIT_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  className="input flex-1"
                  inputMode="decimal"
                  value={costFloorYuan}
                  onChange={(event) => setCostFloorYuan(event.target.value)}
                  placeholder="不填则未设置"
                />
              </div>
            </Field>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-700">样品图（{images.length}/20）</span>
              <label className="cursor-pointer text-xs text-indigo-600 hover:underline">
                选择图片
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="hidden"
                  onChange={(event) => void addFiles(event.target.files)}
                />
              </label>
            </div>
            {images.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-ink-400">
                还没有图片。保存后会显示「待补图」，可随时回来补。
              </div>
            ) : (
              <ul className="grid grid-cols-3 gap-2 md:grid-cols-5">
                {images.map((image, index) => (
                  <li
                    key={`${image.id ?? "new"}-${index}`}
                    className={cn(
                      "overflow-hidden rounded-lg border bg-paper",
                      index === primaryIndex
                        ? "border-indigo-600 ring-1 ring-indigo-600/30"
                        : "border-line",
                    )}
                  >
                    <img
                      src={image.previewUrl}
                      alt="待上传样品图"
                      className="aspect-square w-full object-cover"
                    />
                    <div className="flex flex-wrap items-center gap-1 p-1">
                      <button
                        type="button"
                        className="rounded px-1 text-[10px] text-ink-400 hover:text-ink-900"
                        onClick={() => move(index, -1)}
                        disabled={index === 0}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="rounded px-1 text-[10px] text-ink-400 hover:text-ink-900"
                        onClick={() => move(index, 1)}
                        disabled={index === images.length - 1}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="rounded px-1 text-[10px] text-indigo-600"
                        onClick={() => setPrimaryIndex(index)}
                      >
                        主图
                      </button>
                      <button
                        type="button"
                        className="rounded px-1 text-[10px] text-rose-600"
                        onClick={() => remove(index)}
                      >
                        移除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-ink-400">
            <Badge tone={images.length > 0 ? "info" : "warning"}>
              {images.length > 0 ? "有图" : "待补图"}
            </Badge>
            {images.length > 0 && <span>第 {primaryIndex + 1} 张为主图</span>}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={handleClose} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </footer>
      </div>

      {manageField && (
        <FieldOptionsManager
          fieldKey={manageField}
          onClose={() => setManageField(null)}
          onChanged={() => {
            void compositionOptions.reload();
            void categoryOptions.reload();
          }}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs text-ink-400">{label}</span>
      {children}
    </label>
  );
}
