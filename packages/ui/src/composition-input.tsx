"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CompositionPartsInput, compositionPercentText, compositionText } from "@weave-order/schema";
import type { CompositionPart, CompositionPartInput } from "@weave-order/schema";
import { ComboBox } from "./combobox";
import type { ComboBoxOption } from "./combobox";
import { Button, cn } from "./primitives";

/** 原料清单里的一项（租户级「样品原料」字典）。 */
export interface CompositionMaterial {
  code: string;
  label: string;
}

export interface CompositionInputProps {
  /** 文本模式的当前值（成分原文）。 */
  value: string;
  /** 配比模式的当前值；null = 还没配比。 */
  parts: CompositionPartInput[] | null;
  /** 原料清单。 */
  materials: CompositionMaterial[];
  /** 常用整句成分（只是建议，点了就是文本）。 */
  options?: ComboBoxOption[];
  loading?: boolean;
  loadError?: string | null;
  /** 文本与配比一起回调：配比由服务端派生文本，两边不会各说各话。 */
  onChange: (next: { text: string; parts: CompositionPartInput[] | null }) => void;
  onSaveAsOption?: (label: string) => void | Promise<void>;
  footer?: ReactNode;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * 成分录入：文本与配比两种模式同处一个输入位。
 *
 * - **文本模式**：直接打字（"55% 麻 45% 棉"），配比随之作废；
 * - **配比模式**：摊开原料清单，逐项填百分比，合计必须正好 100% 才让应用。
 *
 * 为什么合计卡死 100：成分标注是合规项，缺一块就是没录全；
 * 而文本模式不受这条约束 —— 供应商表格里「棉涤」不带比例是常态，那是原文不是配比。
 * 文本的最终写法由服务端从配比派生（这里预览用的也是同一份函数），避免两边口径漂移。
 */
export function CompositionInput({
  value,
  parts,
  materials,
  options = [],
  loading = false,
  loadError = null,
  onChange,
  onSaveAsOption,
  footer,
  id,
  placeholder = "如 100% 棉",
  disabled = false,
}: CompositionInputProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 弹层里的百分比草稿：字符串形态，用户没填完时是空串而不是 0。
  const [draft, setDraft] = useState<Record<string, string>>(() => partsToDraft(parts));

  const labelOf = (code: string): string =>
    materials.find((material) => material.code === code)?.label ?? code;

  /**
   * 展示文本：配比模式下由配比现算（与服务端同一份函数），
   * 文本模式下就是原文 —— 两种模式不会各说各话。
   */
  const displayText = useMemo(() => {
    if (!parts || parts.length === 0) return value;
    return compositionText(
      parts.map((part) => ({
        code: part.code,
        label: labelOf(part.code),
        percent: part.percent,
      })),
    );
  }, [parts, value, materials]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return materials;
    return materials.filter((material) => material.label.toLowerCase().includes(needle));
  }, [materials, query]);

  /** 草稿 → 配比：空串不算 0（没填就是没填）。 */
  const draftParts = useMemo<CompositionPartInput[]>(() => {
    const result: CompositionPartInput[] = [];
    for (const material of materials) {
      const raw = draft[material.code]?.trim();
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) continue;
      result.push({ code: material.code, percent: value });
    }
    return result;
  }, [draft, materials]);

  const sum = draftParts.reduce((acc, part) => acc + part.percent, 0);
  // 判定走契约层同一份规则（合计必须 100%、原料不重复），组件不自己算一套。
  const canApply = draftParts.length > 0 && CompositionPartsInput.safeParse(draftParts).success;

  /** 预览用服务端同款派生：带 label 的配比 → 成分文本。 */
  const preview = useMemo(() => {
    if (!canApply) return null;
    const full: CompositionPart[] = draftParts.map((part) => ({
      code: part.code,
      label: labelOf(part.code),
      percent: part.percent,
    }));
    return compositionText(full);
  }, [canApply, draftParts, materials]);

  function openPanel() {
    setDraft(partsToDraft(parts));
    setPanelOpen((open) => !open);
  }

  function apply() {
    if (!canApply || !preview) return;
    onChange({ text: preview, parts: draftParts });
    setPanelOpen(false);
  }

  function clearParts() {
    setDraft({});
    onChange({ text: "", parts: null });
    setPanelOpen(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <ComboBox
            id={id}
            value={displayText}
            options={options}
            loading={loading}
            loadError={loadError}
            onSaveAsOption={onSaveAsOption}
            footer={footer}
            disabled={disabled}
            placeholder={placeholder}
            // 手改文本就是回到文本模式：配比与文本不能同时为真。
            onChange={(next) => onChange({ text: next, parts: null })}
          />
        </div>
        <Button
          type="button"
          variant={parts ? "ghost" : "secondary"}
          disabled={disabled}
          onClick={openPanel}
          className="shrink-0"
        >
          按原料配比
        </Button>
      </div>

      {parts && parts.length > 0 && (
        <p className="text-xs text-ink-400">
          当前是配比录入（{parts.length} 项原料），文本由配比自动生成；手改上面的文本会回到文本模式。
        </p>
      )}

      {panelOpen && (
        <div className="rounded-md border border-line bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input w-40"
              value={query}
              placeholder="搜原料，如 棉"
              onChange={(event) => setQuery(event.target.value)}
            />
            <span className="text-xs text-ink-400">给用到的原料填百分比</span>
          </div>

          {materials.length === 0 && (
            <p className="mt-2 text-xs text-ink-400">
              还没有原料清单，先到设置里补几项（也可以直接用上面的文本录入）。
            </p>
          )}

          {filtered.length > 0 && (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {filtered.map((material) => (
                <li key={material.code} className="flex items-center gap-2">
                  <label className="flex-1 truncate text-sm text-ink-700" htmlFor={`material-${material.code}`}>
                    {material.label}
                  </label>
                  <input
                    id={`material-${material.code}`}
                    className="input w-20 text-right"
                    inputMode="decimal"
                    value={draft[material.code] ?? ""}
                    placeholder="%"
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, [material.code]: event.target.value }))
                    }
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span
              className={cn(
                "rounded px-2 py-1",
                canApply
                  ? "bg-emerald-50 text-emerald-700"
                  : draftParts.length === 0
                    ? "text-ink-400"
                    : "bg-amber-50 text-amber-700",
              )}
            >
              {draftParts.length === 0
                ? "还没填比例"
                : canApply
                  ? `合计 ${compositionPercentText(sum)}%`
                  : `合计 ${compositionPercentText(sum)}%，${
                      sum < 100
                        ? `还差 ${compositionPercentText(100 - sum)}%`
                        : `超出 ${compositionPercentText(sum - 100)}%`
                    }`}
            </span>
            {preview && <span className="text-ink-700">将写成：{preview}</span>}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" disabled={!canApply} onClick={apply}>
              应用配比
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPanelOpen(false)}>
              取消
            </Button>
            {parts && parts.length > 0 && (
              <Button type="button" variant="ghost" onClick={clearParts}>
                清空成分
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 已存配比 → 草稿（字符串百分比）。 */
function partsToDraft(parts: CompositionPartInput[] | null): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const part of parts ?? []) {
    draft[part.code] = compositionPercentText(part.percent);
  }
  return draft;
}
