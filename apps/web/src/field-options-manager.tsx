"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FieldKey, FieldOptionWithUsage } from "@weave-order/schema";
import { Button, cn } from "@weave-order/ui";
import { useApi } from "@/providers";

export const FIELD_LABEL: Record<FieldKey, string> = {
  "customer.tier": "客户等级",
  "sample.category": "样品品类",
  "sample.composition": "样品成分",
  "sample.color": "样品颜色",
  "contact.role": "联系人角色",
};

/** 等级这类 code 引用字段：改名只改 label，历史自动显示新名。 */
function isCodeReference(fieldKey: FieldKey): boolean {
  return fieldKey === "customer.tier";
}

export interface FieldOptionsState {
  options: FieldOptionWithUsage[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * 读公司选项。默认带已停用项：历史数据的 label 要靠它解析；只有下拉建议才按 active 过滤。
 * 加载失败不抛错：组合框要能降级为普通输入，调用方拿 `error` 提示即可。
 */
export function useFieldOptions(fieldKey: FieldKey, withUsage = false): FieldOptionsState {
  const api = useApi();
  const [options, setOptions] = useState<FieldOptionWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setOptions(await api.listFieldOptions(fieldKey, { usage: withUsage }));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "选项加载失败");
    } finally {
      setLoading(false);
    }
  }, [api, fieldKey, withUsage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { options, loading, error, reload };
}

/** code → 当前 label；找不到时回退原 code，绝不显示空白。 */
export function optionLabel(
  options: readonly FieldOptionWithUsage[],
  code: string | null | undefined,
): string {
  if (!code) return "—";
  return options.find((option) => option.code === code)?.label ?? code;
}

/**
 * 就地治理弹层：长在选项被使用的地方（客户列表、样品表单），不是只藏在设置页。
 *
 * 删除/合并对全部角色开放，靠可逆性兜底：删除是软删除且可恢复，合并前必须看到
 * 影响条数与样例并写一条审计。
 */
export function FieldOptionsManager({
  fieldKey,
  onClose,
  onChanged,
}: {
  fieldKey: FieldKey;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const api = useApi();
  const label = FIELD_LABEL[fieldKey];
  const { options, loading, error, reload } = useFieldOptions(fieldKey, true);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [mergeSource, setMergeSource] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [preview, setPreview] = useState<{
    affected: number;
    samples: Array<{ id: string; label: string }>;
  } | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);

  const active = options.filter((option) => option.active);
  const inactive = options.filter((option) => !option.active);
  const source = active.find((option) => option.id === mergeSource) ?? null;
  const targets = useMemo(
    () => active.filter((option) => option.id !== mergeSource),
    [active, mergeSource],
  );

  const changed = useCallback(async () => {
    await reload();
    onChanged?.();
  }, [onChanged, reload]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await changed();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function createOption() {
    const value = newLabel.trim();
    if (!value) return;
    await run(async () => {
      await api.createFieldOption(fieldKey, value);
      setNewLabel("");
    });
  }

  async function saveRename(option: FieldOptionWithUsage) {
    const next = renameDraft.trim();
    if (!next || next === option.label) {
      setRenamingId(null);
      return;
    }
    await run(async () => {
      await api.renameFieldOption(option.id, next);
      setRenamingId(null);
    });
  }

  async function move(option: FieldOptionWithUsage, direction: -1 | 1) {
    const order = active.map((item) => item.id);
    const index = order.indexOf(option.id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next]!, order[index]!];
    // 排序接口要求全量顺序；停用项也一起传，避免后端判定「不一致」。
    const allIds = [...order, ...inactive.map((item) => item.id)];
    await run(async () => {
      await api.reorderFieldOptions(fieldKey, allIds);
    });
  }

  async function askMergePreview(targetId: string) {
    setMergeTarget(targetId);
    setPreview(null);
    if (!source || !targetId) return;
    setMergeBusy(true);
    setActionError(null);
    try {
      const result = await api.previewFieldOptionMerge(source.id, targetId);
      setPreview({ affected: result.affected, samples: result.samples });
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "预览失败");
    } finally {
      setMergeBusy(false);
    }
  }

  async function confirmMerge() {
    if (!source || !mergeTarget) return;
    await run(async () => {
      await api.mergeFieldOptions({
        sourceId: source.id,
        targetId: mergeTarget,
        rewriteText: true,
      });
      setMergeSource(null);
      setMergeTarget("");
      setPreview(null);
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`管理${label}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-y-auto rounded-lg bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink-900">管理{label}</h2>
            <p className="mt-0.5 text-xs text-ink-400">
              全公司共享，任何成员都能改。删除是停用，可随时恢复；合并会改写历史并记一条日志。
            </p>
          </div>
          <Button
            variant="ghost"
            className="min-h-9 px-3 text-xs"
            onClick={onClose}
            disabled={busy}
          >
            关闭
          </Button>
        </header>

        <div className="grid gap-4 px-5 py-4">
          {actionError && (
            <p
              role="alert"
              className="rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600"
            >
              {actionError}
            </p>
          )}
          {error && (
            <p className="rounded-md border border-amber-600/40 bg-amber-100/40 px-3 py-2 text-sm text-amber-700">
              选项没加载出来：{error}
              <Button
                variant="ghost"
                className="ml-2 min-h-7 px-2 text-xs"
                onClick={() => void reload()}
              >
                重试
              </Button>
            </p>
          )}

          <div className="flex gap-2">
            <input
              className="input flex-1"
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              placeholder={`新增${label}，例如 ${
                fieldKey === "sample.composition"
                  ? "棉涤混纺"
                  : fieldKey === "sample.color"
                    ? "藏青"
                    : "针织"
              }`}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createOption();
              }}
            />
            <Button
              variant="primary"
              onClick={() => void createOption()}
              disabled={busy || !newLabel.trim()}
            >
              添加
            </Button>
          </div>

          {mergeSource && source && (
            <section className="rounded-md border border-indigo-600/30 bg-indigo-100/30 p-3">
              <p className="text-sm text-ink-900">
                把「{source.label}」合并到哪个选项？合并会改写历史，是唯一会动业务数据的操作。
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  className="input min-w-40 flex-1"
                  value={mergeTarget}
                  onChange={(event) => void askMergePreview(event.target.value)}
                >
                  <option value="">选择目标选项…</option>
                  {targets.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}（{option.usage} 处使用）
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setMergeSource(null);
                    setMergeTarget("");
                    setPreview(null);
                  }}
                >
                  取消合并
                </Button>
              </div>
              {mergeBusy && <p className="mt-2 text-xs text-ink-400">正在统计影响…</p>}
              {preview && (
                <div className="mt-2 rounded border border-line bg-surface p-2 text-sm">
                  <p className="text-ink-900">
                    将影响 <strong>{preview.affected}</strong> 条记录
                  </p>
                  {preview.samples.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-ink-700">
                      {preview.samples.map((sample) => (
                        <li key={sample.id}>{sample.label}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      variant="danger"
                      className="min-h-9 px-3 text-xs"
                      onClick={() => void confirmMerge()}
                      disabled={busy || mergeBusy}
                    >
                      确认合并（{preview.affected} 条）
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="grid gap-1">
            {loading && <p className="text-sm text-ink-400">正在加载…</p>}
            {!loading && active.length === 0 && (
              <p className="text-sm text-ink-400">还没有{label}，先添加一个。</p>
            )}
            <ul className="divide-y divide-line rounded-md border border-line">
              {active.map((option, index) => (
                <li key={option.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      aria-label={`上移 ${option.label}`}
                      className="text-xs text-ink-400 hover:text-ink-900 disabled:opacity-30"
                      disabled={index === 0 || busy}
                      onClick={() => void move(option, -1)}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label={`下移 ${option.label}`}
                      className="text-xs text-ink-400 hover:text-ink-900 disabled:opacity-30"
                      disabled={index === active.length - 1 || busy}
                      onClick={() => void move(option, 1)}
                    >
                      ▼
                    </button>
                  </div>
                  <div className="min-w-0 flex-1">
                    {renamingId === option.id ? (
                      <div className="grid gap-2">
                        <input
                          className="input"
                          autoFocus
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void saveRename(option);
                            if (event.key === "Escape") setRenamingId(null);
                          }}
                        />
                        <p className="text-xs text-ink-400">
                          {isCodeReference(fieldKey)
                            ? "历史客户会自动显示新名字。"
                            : `改名只改建议名，不会改动历史记录（当前 ${option.usage} 处使用）。要一并改写历史，请用「合并」。`}
                        </p>
                        <div className="flex gap-2">
                          <Button
                            variant="primary"
                            className="min-h-8 px-3 text-xs"
                            disabled={busy}
                            onClick={() => void saveRename(option)}
                          >
                            保存改名
                          </Button>
                          {!isCodeReference(fieldKey) && option.usage > 0 && (
                            <Button
                              variant="secondary"
                              className="min-h-8 px-3 text-xs"
                              onClick={() => {
                                setRenamingId(null);
                                setMergeSource(option.id);
                                setMergeTarget("");
                                setPreview(null);
                              }}
                            >
                              改为合并到其他选项
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="text-sm text-ink-900">{option.label}</p>
                        <p className="text-xs text-ink-400">
                          {option.usage} 处使用
                          {option.code !== option.label ? ` · ${option.code}` : ""}
                        </p>
                      </>
                    )}
                  </div>
                  {renamingId !== option.id && (
                    <div className="flex shrink-0 flex-wrap gap-1">
                      <Button
                        variant="ghost"
                        className="min-h-8 px-2 text-xs"
                        disabled={busy}
                        onClick={() => {
                          setRenamingId(option.id);
                          setRenameDraft(option.label);
                        }}
                      >
                        改名
                      </Button>
                      <Button
                        variant="ghost"
                        className="min-h-8 px-2 text-xs"
                        disabled={busy || active.length < 2}
                        onClick={() => {
                          setMergeSource(option.id);
                          setMergeTarget("");
                          setPreview(null);
                        }}
                      >
                        合并
                      </Button>
                      <Button
                        variant="ghost"
                        className="min-h-8 px-2 text-xs text-vermilion-600"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `停用「${option.label}」？历史记录会保留原文字，可随时恢复。`,
                            )
                          ) {
                            void run(() => api.deleteFieldOption(option.id));
                          }
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {inactive.length > 0 && (
            <section className="grid gap-1">
              <h3 className="text-xs font-medium text-ink-400">已停用（历史仍显示原名）</h3>
              <ul className="divide-y divide-line rounded-md border border-line bg-paper/40">
                {inactive.map((option) => (
                  <li key={option.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className={cn("text-sm text-ink-400 line-through")}>{option.label}</span>
                    <Button
                      variant="ghost"
                      className="min-h-8 px-2 text-xs"
                      disabled={busy}
                      onClick={() =>
                        void run(() => api.restoreFieldOption(option.id).then(() => undefined))
                      }
                    >
                      恢复
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

const SUMMARY_FIELDS: FieldKey[] = [
  "customer.tier",
  "sample.category",
  "sample.composition",
  "sample.color",
  "contact.role",
];

/**
 * 设置页「客户与字段」汇总视图。
 *
 * 只是全公司选项的总览 + 跳转入口，不是唯一治理入口：真正的日常操作发生在
 * 客户列表（管理等级）和样品表单（管理品类/成分）。
 */
export function FieldOptionsSummary() {
  const api = useApi();
  const [rows, setRows] = useState<
    Array<{ fieldKey: FieldKey; count: number; usage: number; error: string | null }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [manageField, setManageField] = useState<FieldKey | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(
      SUMMARY_FIELDS.map(async (fieldKey) => {
        try {
          const options = await api.listFieldOptions(fieldKey, { usage: true });
          return {
            fieldKey,
            count: options.filter((option) => option.active).length,
            usage: options.reduce((sum, option) => sum + option.usage, 0),
            error: null,
          };
        } catch (caught) {
          return {
            fieldKey,
            count: 0,
            usage: 0,
            error: caught instanceof Error ? caught.message : "加载失败",
          };
        }
      }),
    );
    setRows(results);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-ink-900">客户与字段</h2>
          <p className="mt-0.5 text-xs text-ink-400">
            全公司共享的等级、品类、成分与联系人角色。日常也可以直接在客户列表、样品表单里管理。
          </p>
        </div>
        <Button
          variant="ghost"
          className="min-h-8 px-2 text-xs"
          onClick={() => void load()}
          disabled={loading}
        >
          刷新
        </Button>
      </div>
      <dl className="mt-2 divide-y divide-line">
        {rows.map((row) => (
          <div
            key={row.fieldKey}
            className="flex flex-wrap items-center justify-between gap-2 py-3"
          >
            <div>
              <dt className="text-sm text-ink-900">{FIELD_LABEL[row.fieldKey]}</dt>
              <dd className="mt-0.5 text-xs text-ink-400">
                {row.error
                  ? `加载失败：${row.error}`
                  : `${row.count} 个启用选项 · 被 ${row.usage} 条记录使用`}
              </dd>
            </div>
            <Button
              variant="secondary"
              className="min-h-8 px-3 text-xs"
              onClick={() => setManageField(row.fieldKey)}
            >
              管理
            </Button>
          </div>
        ))}
        {loading && rows.length === 0 && <p className="py-3 text-sm text-ink-400">正在统计…</p>}
      </dl>

      {manageField && (
        <FieldOptionsManager
          fieldKey={manageField}
          onClose={() => setManageField(null)}
          onChanged={() => void load()}
        />
      )}
    </section>
  );
}
