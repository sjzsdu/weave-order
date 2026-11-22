"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  CompositionPartInput,
  FabricSample,
  FieldKey,
  Unit,
  WeightUnit,
  WidthUnit,
} from "@weave-order/schema";
import {
  WEIGHT_UNITS,
  WEIGHT_UNIT_LABEL,
  WIDTH_UNITS,
  WIDTH_UNIT_LABEL,
  weightGsmOf,
  widthCmOf,
} from "@weave-order/schema";
import { Badge, Button, ComboBox, CompositionInput, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { FieldOptionsManager, useFieldOptions } from "@/field-options-manager";
import { useMeasureUnits } from "@/measure-units";
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

interface SampleDraftErrors {
  code?: string;
  name?: string;
  costFloor?: string;
  weight?: string;
  width?: string;
}

/**
 * 数值文本 → 数值。
 *
 * 空 = 没填（null）；不是正数 = 录错了（undefined）。
 * 单位由下拉单独选，所以这里只管数值。
 */
function measurementNumber(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

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
  // 成分配比（原料 code + 百分比）：null = 文本模式。
  const [compositionParts, setCompositionParts] = useState<CompositionPartInput[] | null>(null);
  const [category, setCategory] = useState("");
  const [color, setColor] = useState("");
  const [weightValue, setWeightValue] = useState("");
  // 单位下拉的选中项：null = 还没选，用公司默认；选了就是这条样品自己的单位。
  const [weightUnit, setWeightUnit] = useState<WeightUnit | null>(null);
  const [widthValue, setWidthValue] = useState("");
  const [widthUnit, setWidthUnit] = useState<WidthUnit | null>(null);
  const [unit, setUnit] = useState<Unit>("meter");
  const [costFloorYuan, setCostFloorYuan] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [primaryIndex, setPrimaryIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<SampleDraftErrors>({});
  const [manageField, setManageField] = useState<FieldKey | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const costFloorRef = useRef<HTMLInputElement>(null);
  const compositionOptions = useFieldOptions("sample.composition");
  const materialOptions = useFieldOptions("sample.material");
  const categoryOptions = useFieldOptions("sample.category");
  const colorOptions = useFieldOptions("sample.color");
  const defaults = useMeasureUnits();

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFieldErrors({});
    setBusy(false);
    setCode(sample?.code ?? suggestCode());
    setName(sample?.name ?? "");
    setComposition(sample?.composition ?? "");
    setCompositionParts(sample?.compositionParts ?? null);
    setCategory(sample?.category ?? "");
    setColor(sample?.color ?? "");
    // 数值与单位分开存：数值是文本框，单位是下拉。
    setWeightValue(sample?.weight ? String(sample.weight.value) : "");
    setWeightUnit(sample?.weight?.unit ?? null);
    setWidthValue(sample?.width ? String(sample.width.value) : "");
    setWidthUnit(sample?.width?.unit ?? null);
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

  /** 生效的单位：用户选过就用用户的，否则用公司默认。 */
  const effectiveWeightUnit = weightUnit ?? defaults.weight;
  const effectiveWidthUnit = widthUnit ?? defaults.width;

  /** 克重：null = 没填；undefined = 录错了。 */
  const weightMeasurement = useMemo(() => {
    const value = measurementNumber(weightValue);
    if (value === undefined) return undefined;
    if (value === null) return null;
    return { value, unit: effectiveWeightUnit };
  }, [weightValue, effectiveWeightUnit]);

  /** 门幅：同上。 */
  const widthMeasurement = useMemo(() => {
    const value = measurementNumber(widthValue);
    if (value === undefined) return undefined;
    if (value === null) return null;
    return { value, unit: effectiveWidthUnit };
  }, [widthValue, effectiveWidthUnit]);

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
    const found: SampleDraftErrors = {};
    if (!code.trim()) found.code = "编码必填";
    if (!name.trim()) found.name = "品名必填";
    if (costFloor === undefined) found.costFloor = "成本底线必须是数字（元）";
    if (weightMeasurement === undefined) found.weight = "克重要填大于 0 的数字";
    if (widthMeasurement === undefined) found.width = "门幅要填大于 0 的数字";
    setFieldErrors(found);
    if (Object.keys(found).length > 0) {
      // 错误必须在字段旁边出现，并把焦点带到第一个缺失项：底部通用错误在长表单里会被忽略。
      requestAnimationFrame(() => {
        if (found.code) codeRef.current?.focus();
        else if (found.name) nameRef.current?.focus();
        else costFloorRef.current?.focus();
      });
      return;
    }
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
              compositionParts,
              category: category.trim() || null,
              color: color.trim() || null,
              weight: weightMeasurement ?? null,
              width: widthMeasurement ?? null,
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
          compositionParts,
          category: category.trim() || null,
          color: color.trim() || null,
          weight: weightMeasurement ?? null,
          width: widthMeasurement ?? null,
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
            <Field label="编码 *" error={fieldErrors.code} errorId="sample-code-error">
              <input
                id="sample-code"
                ref={codeRef}
                className="input"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setFieldErrors((current) => ({ ...current, code: undefined }));
                }}
                placeholder="如 FM-220"
                required
                aria-required="true"
                aria-invalid={fieldErrors.code ? true : undefined}
                aria-describedby={fieldErrors.code ? "sample-code-error" : undefined}
              />
            </Field>
            <Field label="品名 *" error={fieldErrors.name} errorId="sample-name-error">
              <input
                id="sample-name"
                ref={nameRef}
                className="input"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setFieldErrors((current) => ({ ...current, name: undefined }));
                }}
                placeholder="如 32S 精梳棉汗布"
                required
                aria-required="true"
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={fieldErrors.name ? "sample-name-error" : undefined}
              />
            </Field>
            <Field label="成分">
              <CompositionInput
                id="sample-composition"
                value={composition}
                parts={compositionParts}
                onChange={(next) => {
                  setComposition(next.text);
                  setCompositionParts(next.parts);
                }}
                materials={materialOptions.options
                  .filter((option) => option.active)
                  .map((option) => ({ code: option.code, label: option.label }))}
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
            <Field label="颜色">
              <ComboBox
                value={color}
                onChange={setColor}
                options={colorOptions.options
                  .filter((option) => option.active)
                  .map((option) => ({ value: option.code, label: option.label }))}
                loading={colorOptions.loading}
                loadError={colorOptions.error}
                onSaveAsOption={async (label) => {
                  try {
                    await api.createFieldOption("sample.color", label);
                    await colorOptions.reload();
                  } catch (caught) {
                    setError(caught instanceof Error ? caught.message : "保存颜色选项失败");
                  }
                }}
                footer={
                  <button
                    type="button"
                    className="text-xs text-indigo-700 hover:underline"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setManageField("sample.color")}
                  >
                    管理颜色
                  </button>
                }
                placeholder="如 藏青"
              />
            </Field>
            <Field label="克重" error={fieldErrors.weight} errorId="sample-weight-error">
              <div className="flex gap-2">
                <input
                  id="sample-weight"
                  className="input flex-1"
                  inputMode="decimal"
                  value={weightValue}
                  onChange={(event) => {
                    setWeightValue(event.target.value);
                    setFieldErrors((current) => ({ ...current, weight: undefined }));
                  }}
                  placeholder="如 220"
                  aria-invalid={fieldErrors.weight ? true : undefined}
                  aria-describedby={fieldErrors.weight ? "sample-weight-error" : undefined}
                />
                {/* 单位单独放在输入框后面：数值与单位各管各的，录错单位的概率从根上没了。 */}
                <select
                  className="input w-28"
                  value={effectiveWeightUnit}
                  onChange={(event) => setWeightUnit(event.target.value as WeightUnit)}
                >
                  {WEIGHT_UNITS.map((option) => (
                    <option key={option} value={option}>
                      {WEIGHT_UNIT_LABEL[option]}
                    </option>
                  ))}
                </select>
              </div>
              <span className="mt-1 block text-xs text-ink-400">
                {weightMeasurement === undefined
                  ? "克重要填大于 0 的数字"
                  : weightMeasurement === null
                    ? "克重未填"
                    : `筛选克重：${weightGsmOf(weightMeasurement)} g/m²`}
              </span>
            </Field>
            <Field label="门幅" error={fieldErrors.width} errorId="sample-width-error">
              <div className="flex gap-2">
                <input
                  id="sample-width"
                  className="input flex-1"
                  inputMode="decimal"
                  value={widthValue}
                  onChange={(event) => {
                    setWidthValue(event.target.value);
                    setFieldErrors((current) => ({ ...current, width: undefined }));
                  }}
                  placeholder="如 150"
                  aria-invalid={fieldErrors.width ? true : undefined}
                  aria-describedby={fieldErrors.width ? "sample-width-error" : undefined}
                />
                <select
                  className="input w-28"
                  value={effectiveWidthUnit}
                  onChange={(event) => setWidthUnit(event.target.value as WidthUnit)}
                >
                  {WIDTH_UNITS.map((option) => (
                    <option key={option} value={option}>
                      {WIDTH_UNIT_LABEL[option]}
                    </option>
                  ))}
                </select>
              </div>
              <span className="mt-1 block text-xs text-ink-400">
                {widthMeasurement === undefined
                  ? "门幅要填大于 0 的数字"
                  : widthMeasurement === null
                    ? "门幅未填"
                    : `折合 ${widthCmOf(widthMeasurement)} cm`}
              </span>
            </Field>
            <Field
              label="单位与成本底线（元）"
              error={fieldErrors.costFloor}
              errorId="sample-cost-floor-error"
            >
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
                  id="sample-cost-floor"
                  ref={costFloorRef}
                  className="input flex-1"
                  inputMode="decimal"
                  value={costFloorYuan}
                  onChange={(event) => {
                    setCostFloorYuan(event.target.value);
                    setFieldErrors((current) => ({ ...current, costFloor: undefined }));
                  }}
                  placeholder="不填则未设置"
                  aria-invalid={fieldErrors.costFloor ? true : undefined}
                  aria-describedby={fieldErrors.costFloor ? "sample-cost-floor-error" : undefined}
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
            void colorOptions.reload();
          }}
        />
      )}
    </div>
  );
}

function Field({
  label,
  error,
  errorId,
  children,
}: {
  label: string;
  error?: string;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-xs text-ink-400">{label}</span>
      {children}
      {error && (
        <span id={errorId} role="alert" className="text-xs text-vermilion-600">
          {error}
        </span>
      )}
    </label>
  );
}
