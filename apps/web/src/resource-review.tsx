"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompositionPartInput,
  JsonValue,
  ResourceFieldView,
  WeightUnit,
  WidthUnit,
} from "@weave-order/schema";
import {
  WEIGHT_UNITS,
  WEIGHT_UNIT_LABEL,
  WIDTH_UNITS,
  WIDTH_UNIT_LABEL,
} from "@weave-order/schema";
import { Badge, Button, Card, CompositionInput, EmptyState, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMeasureUnits } from "@/measure-units";
import { useFieldOptions } from "./field-options-manager";
import { FIELD_LABEL, confirmErrorMessage } from "./resource-review-copy";

const SOURCE_LABEL: Record<string, string> = {
  bizcard: "名片识别",
  label: "标签识别",
  history: "历史数据",
  manual: "人工录入",
  llm: "模型推断",
};

const STATUS_META: Record<
  ResourceFieldView["status"],
  { label: string; tone: "warning" | "success" | "danger" | "info" }
> = {
  PENDING: { label: "待确认", tone: "warning" },
  CONFIRMED: { label: "已确认", tone: "success" },
  EDITED: { label: "已改正", tone: "info" },
  CONFLICT: { label: "有冲突", tone: "danger" },
};

function valueText(value: ResourceFieldView["value"]): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // 克重 / 门幅在矩阵里是「数值 + 单位」这一对：这里只取数值，单位另外渲染。
  const measurement = measurementOf(value);
  if (measurement) return String(measurement.value);
  return JSON.stringify(value);
}

/** 矩阵里的克重 / 门幅值：`{ value, unit }`。 */
function measurementOf(
  value: ResourceFieldView["value"],
): { value: number; unit: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.value !== "number" || typeof record.unit !== "string") return null;
  return { value: record.value, unit: record.unit };
}

/** 矩阵里的成分值：文本模式是字符串，配比模式是 `{ parts: [...] }`。 */
function compositionPartsOf(
  value: ResourceFieldView["value"],
): { text: string; parts: CompositionPartInput[] | null } {
  if (typeof value === "string") return { text: value, parts: null };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { text: "", parts: null };
  }
  const parts = (value as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return { text: "", parts: null };
  const parsed: CompositionPartInput[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as { code?: unknown; percent?: unknown };
    if (typeof record.code !== "string" || typeof record.percent !== "number") continue;
    parsed.push({ code: record.code, percent: record.percent });
  }
  return { text: "", parts: parsed.length > 0 ? parsed : null };
}

interface ResourceReviewProps {
  resourceType: "customer" | "sample";
  resourceId: string;
}

/**
 * 草稿确认页：字段列表 + 出处 + 冲突选择 + 逐字段确认。
 * 移动端单列、触控目标 ≥ 44px；不在这里改导航或布局。
 */
export function ResourceReview({ resourceType, resourceId }: ResourceReviewProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const defaults = useMeasureUnits();
  const key = [resourceType, resourceId, "fields"] as const;
  const fieldsQuery = useQuery({
    queryKey: key,
    queryFn: () =>
      resourceType === "customer" ? api.customerFields(resourceId) : api.sampleFields(resourceId),
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  // 克重 / 门幅：数值进文本框，单位进下拉（与样品编辑面同一套口径）。
  const [weightDraft, setWeightDraft] = useState<{ value: string; unit: WeightUnit }>({
    value: "",
    unit: defaults.weight,
  });
  const [widthDraft, setWidthDraft] = useState<{ value: string; unit: WidthUnit }>({
    value: "",
    unit: defaults.width,
  });
  // 成分：文本与配比同存一份（配比模式下文本由服务端派生）。
  const [compositionDraft, setCompositionDraft] = useState<{
    text: string;
    parts: CompositionPartInput[] | null;
  }>({ text: "", parts: null });
  const materialOptions = useFieldOptions("sample.material");
  const [feedback, setFeedback] = useState<string | null>(null);

  const data = fieldsQuery.data;
  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const field of data.fields) next[field.fieldName] = valueText(field.value);
    setDraft(next);
    const weight = measurementOf(data.fields.find((f) => f.fieldName === "weight")?.value ?? null);
    const width = measurementOf(data.fields.find((f) => f.fieldName === "width")?.value ?? null);
    setWeightDraft({
      value: weight ? String(weight.value) : "",
      unit: (weight?.unit as WeightUnit | undefined) ?? defaults.weight,
    });
    setWidthDraft({
      value: width ? String(width.value) : "",
      unit: (width?.unit as WidthUnit | undefined) ?? defaults.width,
    });
    setCompositionDraft(
      compositionPartsOf(data.fields.find((f) => f.fieldName === "composition")?.value ?? null),
    );
  }, [data, defaults.weight, defaults.width]);

  /**
   * 提交用的字段值。
   *
   * 克重 / 门幅提交「数值 + 单位」这一对；填不出正数就当没填（不写半个值进主表）。
   */
  const fieldValue = (fieldName: string): JsonValue => {
    if (fieldName === "weight") {
      const value = Number(weightDraft.value.trim());
      if (weightDraft.value.trim() === "" || !Number.isFinite(value) || value <= 0) return "";
      return { value, unit: weightDraft.unit };
    }
    if (fieldName === "width") {
      const value = Number(widthDraft.value.trim());
      if (widthDraft.value.trim() === "" || !Number.isFinite(value) || value <= 0) return "";
      return { value, unit: widthDraft.unit };
    }
    if (fieldName === "composition") {
      // 配比模式交结构化明细，文本由服务端派生；文本模式交原文。
      if (compositionDraft.parts && compositionDraft.parts.length > 0) {
        return { parts: compositionDraft.parts };
      }
      return compositionDraft.text.trim() || draft[fieldName] || "";
    }
    return draft[fieldName] ?? "";
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!data) throw new Error("字段还没加载");
      const fields = data.fields
        .filter((field) => !["code", "tier", "unit"].includes(field.fieldName))
        .map((field) => ({ fieldName: field.fieldName, value: fieldValue(field.fieldName) }))
        .filter((field) => field.value !== "");
      if (fields.length === 0) throw new Error("没有可确认的字段");
      return resourceType === "customer"
        ? api.updateCustomerFields(resourceId, { fields })
        : api.updateSampleFields(resourceId, { fields });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(key, result);
      setFeedback("字段已逐项确认");
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "保存失败"),
  });

  const confirm = useMutation({
    mutationFn: async () =>
      resourceType === "customer" ? api.confirmCustomer(resourceId) : api.confirmSample(resourceId),
    onSuccess: async () => {
      setFeedback("已确认可用，接下来可以建事项或报价");
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => setFeedback(confirmErrorMessage(error)),
  });

  const pendingCount = useMemo(
    () =>
      data?.fields.filter((field) => field.status === "PENDING" || field.status === "CONFLICT")
        .length ?? 0,
    [data],
  );
  const draftStatus = data?.resourceStatus === "DRAFT";
  const statusText = (() => {
    const base = draftStatus ? "草稿" : "可用";
    return pendingCount > 0 ? `${base} · ${pendingCount} 项待确认` : base;
  })();

  if (fieldsQuery.isLoading) return <Spinner label="正在读取字段与出处…" />;
  if (fieldsQuery.isError || !data) {
    return (
      <EmptyState
        title="找不到这份草稿"
        description={
          fieldsQuery.error instanceof Error
            ? fieldsQuery.error.message
            : "请从客户或样品列表重新进入"
        }
      />
    );
  }

  return (
    <div className="grid gap-4 pb-6">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-ink-900">
              确认{resourceType === "customer" ? "客户" : "样品"}信息
            </h1>
            <p className="mt-1 text-sm text-ink-400">
              每个字段都能看到出处；确认错了可以直接改，改过的字段标为「已改正」。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* 状态只用一个徽标表达：「可用」和「还有 N 项待确认」并列会让人以为已经完成。
                草稿允许缺非关键字段，所以待确认是状态的一部分，不是另一个并列状态。 */}
            <Badge tone={pendingCount > 0 || draftStatus ? "warning" : "success"}>
              {statusText}
            </Badge>
          </div>
        </div>
      </Card>

      <div className="grid gap-3">
        {data.fields.map((field) => {
          const meta = STATUS_META[field.status];
          return (
            <Card key={field.fieldName} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <label
                  htmlFor={`field-${field.fieldName}`}
                  className="text-sm font-medium text-ink-700"
                >
                  {FIELD_LABEL[field.fieldName] ?? field.fieldName}
                </label>
                <Badge tone={meta.tone}>{meta.label}</Badge>
                <span className="text-xs text-ink-400">
                  出处：{SOURCE_LABEL[field.sourceKind] ?? field.sourceKind}
                  {field.sourceId ? ` · 原件 ${field.sourceId.slice(0, 8)}` : ""}
                </span>
              </div>

              {field.status === "CONFLICT" && field.candidates.length > 0 ? (
                <div className="mt-3 grid gap-2">
                  {field.candidates.map((candidate, index) => {
                    const text = valueText(candidate.value);
                    return (
                      <label
                        key={`${text}-${index}`}
                        className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line bg-paper px-3 py-2 text-sm"
                      >
                        <input
                          type="radio"
                          name={`conflict-${field.fieldName}`}
                          checked={draft[field.fieldName] === text}
                          onChange={() =>
                            setDraft((current) => ({ ...current, [field.fieldName]: text }))
                          }
                        />
                        <span className="flex-1 text-ink-900">{text || "（空）"}</span>
                        <span className="text-xs text-ink-400">
                          {SOURCE_LABEL[candidate.sourceKind] ?? candidate.sourceKind}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : field.fieldName === "weight" ? (
                <div className="mt-3 flex gap-2">
                  <input
                    id="field-weight"
                    className="min-h-11 flex-1 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
                    inputMode="decimal"
                    value={weightDraft.value}
                    placeholder="如 220"
                    onChange={(event) =>
                      setWeightDraft((current) => ({ ...current, value: event.target.value }))
                    }
                  />
                  {/* 单位单独放在输入框后面：数值与单位各管各的。 */}
                  <select
                    className="min-h-11 w-28 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
                    value={weightDraft.unit}
                    onChange={(event) =>
                      setWeightDraft((current) => ({
                        ...current,
                        unit: event.target.value as WeightUnit,
                      }))
                    }
                  >
                    {WEIGHT_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {WEIGHT_UNIT_LABEL[unit]}
                      </option>
                    ))}
                  </select>
                </div>
              ) : field.fieldName === "width" ? (
                <div className="mt-3 flex gap-2">
                  <input
                    id="field-width"
                    className="min-h-11 flex-1 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
                    inputMode="decimal"
                    value={widthDraft.value}
                    placeholder="如 150"
                    onChange={(event) =>
                      setWidthDraft((current) => ({ ...current, value: event.target.value }))
                    }
                  />
                  <select
                    className="min-h-11 w-28 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
                    value={widthDraft.unit}
                    onChange={(event) =>
                      setWidthDraft((current) => ({
                        ...current,
                        unit: event.target.value as WidthUnit,
                      }))
                    }
                  >
                    {WIDTH_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {WIDTH_UNIT_LABEL[unit]}
                      </option>
                    ))}
                  </select>
                </div>
              ) : field.fieldName === "composition" ? (
                <div className="mt-3">
                  <CompositionInput
                    id="field-composition"
                    value={compositionDraft.text}
                    parts={compositionDraft.parts}
                    onChange={(next) => setCompositionDraft(next)}
                    materials={materialOptions.options
                      .filter((option) => option.active)
                      .map((option) => ({ code: option.code, label: option.label }))}
                  />
                </div>
              ) : (
                <input
                  id={`field-${field.fieldName}`}
                  className="mt-3 min-h-11 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
                  value={draft[field.fieldName] ?? ""}
                  placeholder="待补充"
                  readOnly={field.fieldName === "code"}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [field.fieldName]: event.target.value,
                    }))
                  }
                />
              )}
            </Card>
          );
        })}
      </div>

      <div className="rounded-lg border border-line bg-surface p-3">
        <div className="mx-auto grid max-w-3xl grid-cols-2 gap-2 md:flex md:items-center md:gap-3">
          <Button
            className="min-h-11 md:flex-1"
            variant="secondary"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "保存中…" : "逐字段确认"}
          </Button>
          <Button
            className="min-h-11 md:flex-1"
            disabled={confirm.isPending || data.resourceStatus !== "DRAFT"}
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? "确认中…" : "确认可用"}
          </Button>
        </div>
        {feedback ? (
          <p className="mx-auto mt-2 max-w-3xl text-xs text-ink-400" role="status">
            {feedback}
          </p>
        ) : null}
      </div>
    </div>
  );
}
