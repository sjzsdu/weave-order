"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./primitives";

export interface ComboBoxOption {
  /** 选项稳定标识（等级是 code，文本字段是任意 id）；点击建议时回传 label。 */
  value: string;
  label: string;
}

export interface ComboBoxProps {
  value: string;
  onChange: (next: string) => void;
  options: ComboBoxOption[];
  placeholder?: string;
  /** 选项加载失败时输入照常，只提示；不阻断提交。 */
  loadError?: string | null;
  loading?: boolean;
  /** 无匹配时的「保存为选项」入口；缺省则不展示该按钮。 */
  onSaveAsOption?: (label: string) => void | Promise<void>;
  saveAsOptionLabel?: string;
  /** 下拉底部附加内容（如「管理品类 / 成分」）。 */
  footer?: ReactNode;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  inputClassName?: string;
}

/** NFKC + trim + 折叠空白 + 小写：与 `normalizeFieldValue` 同规则，仅用于前端高亮。 */
function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[A-Z\u00C0-\u00D6\u00D8-\u00DE]/g, (char) => char.toLowerCase());
}

/**
 * 可输入组合框：下拉建议 + 直接打字。
 *
 * 关键约束：
 * - **输入法组合期间不筛选、不提交**：中文候选还在编辑时按 Enter 只是确认候选，
 *   不能把它当成「选中某一项」，否则用户选词就会误选。
 * - **完全匹配（归一化后）定位已有选项**：只提示「已是选项」，不做模糊替换。
 * - **加载失败降级**：选项请求失败不锁输入，只显示一行提示。
 */
export function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  loadError,
  loading = false,
  onSaveAsOption,
  saveAsOptionLabel = "保存为选项",
  footer,
  disabled,
  id,
  ariaLabel,
  inputClassName,
}: ComboBoxProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [composing, setComposing] = useState(false);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeOptions = useMemo(
    () => options.filter((option) => option.label.trim() !== ""),
    [options],
  );
  const query = normalize(value);
  // 组合期间冻结过滤结果：每敲一个拼音字母就重排下拉会让候选词跳走。
  const [frozenQuery, setFrozenQuery] = useState(query);
  useEffect(() => {
    if (!composing) setFrozenQuery(query);
  }, [composing, query]);

  const filtered = useMemo(() => {
    if (!frozenQuery) return activeOptions.slice(0, 8);
    return activeOptions
      .filter((option) => normalize(option.label).includes(frozenQuery))
      .slice(0, 8);
  }, [activeOptions, frozenQuery]);

  const exact = activeOptions.find((option) => normalize(option.label) === query);
  const canOfferSave = Boolean(onSaveAsOption) && value.trim() !== "" && !exact;

  useEffect(() => {
    setHighlight(0);
  }, [frozenQuery]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function choose(option: ComboBoxOption) {
    onChange(option.label);
    setOpen(false);
  }

  async function save() {
    if (!onSaveAsOption || saving) return;
    setSaving(true);
    try {
      await onSaveAsOption(value.trim());
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <input
        id={id}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-autocomplete="list"
        role="combobox"
        className={cn("input w-full", inputClassName)}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value);
          if (!composing) setOpen(true);
        }}
        onCompositionStart={() => {
          setComposing(true);
          setOpen(true);
        }}
        onCompositionEnd={(event) => {
          setComposing(false);
          onChange(event.currentTarget.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          // 组合中的 Enter 属于输入法（确认候选词），不参与选项选择。
          if (composing || event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setHighlight((current) => Math.min(current + 1, Math.max(filtered.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((current) => Math.max(current - 1, 0));
          } else if (event.key === "Enter") {
            const option = filtered[highlight];
            if (open && option) {
              event.preventDefault();
              choose(option);
            } else {
              setOpen(false);
            }
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />

      {open && !disabled && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-line bg-surface shadow-lg">
          {loading && <p className="px-3 py-2 text-xs text-ink-400">正在加载选项…</p>}
          {loadError && (
            <p className="border-b border-line px-3 py-2 text-xs text-amber-700">
              选项没加载出来，仍可直接输入：{loadError}
            </p>
          )}
          {!loading && filtered.length === 0 && !loadError && (
            <p className="px-3 py-2 text-xs text-ink-400">
              {query ? "没有匹配的选项，可直接使用或保存" : "还没有选项"}
            </p>
          )}
          {filtered.length > 0 && (
            <ul role="listbox" className="max-h-56 overflow-y-auto py-1">
              {filtered.map((option, index) => (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === highlight}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm",
                      index === highlight ? "bg-indigo-100/60 text-ink-900" : "text-ink-700",
                    )}
                    onMouseEnter={() => setHighlight(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(option)}
                  >
                    <span>{option.label}</span>
                    {exact && normalize(option.label) === query && (
                      <span className="text-xs text-ink-400">已是选项</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {(canOfferSave || value.trim() !== "") && (
            <div className="border-t border-line px-1 py-1">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-ink-700 hover:bg-paper"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setOpen(false)}
              >
                <span aria-hidden>＋</span>
                使用「{value.trim() || "…"}」
              </button>
              {canOfferSave && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-indigo-700 hover:bg-paper disabled:opacity-50"
                  disabled={saving}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void save()}
                >
                  <span aria-hidden>☆</span>
                  {saving ? "正在保存…" : `${saveAsOptionLabel}「${value.trim()}」`}
                </button>
              )}
            </div>
          )}

          {footer && <div className="border-t border-line bg-paper/60 px-3 py-2">{footer}</div>}
        </div>
      )}
    </div>
  );
}
