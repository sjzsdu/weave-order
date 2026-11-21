"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PRINT_DOCUMENT_VARIABLES,
  PRINT_VARIABLES,
  type PrintLayoutBlock,
  type PrintPreviewArtifact,
  type PrintTemplateDetail,
  type PrintTemplateLayout,
} from "@weave-order/schema";
import { Badge, Button, Spinner } from "@weave-order/ui";
import { useCan } from "@/can";
import { useApi } from "@/providers";

/**
 * 样卡模板编辑器（P0c）。
 *
 * 编辑的是「版式」：一行一个白名单字段 + 二维码位置/大小。发布时后端把版式
 * 编译成 HTML / ZPL / TSPL，因此这里既能所见即所得，也不会绕开变量白名单。
 *
 * 版本规则：草稿可反复保存；发布生成新版本；已发布版本一行不改，回滚只是把
 * 当前版本指针指回历史版本。
 */

const FORMAT_LABEL = {
  HTML: "A4 样卡",
  ZPL: "80×50 标签（ZPL）",
  TSPL: "80×50 标签（TSPL）",
} as const;

/** 二维码图片字段由「二维码」区块负责，不能当文字行。 */
const QR_FIELD_PATHS = new Set(["card.qrImage", "card.qr", "box.qr"]);

const FIELD_OPTIONS = PRINT_DOCUMENT_VARIABLES.SAMPLE_LABEL.filter(
  (path) => !QR_FIELD_PATHS.has(path),
).map((path) => ({
  value: path,
  label: `${PRINT_VARIABLES[path]}（${path}）`,
}));

function fieldLabel(path: string): string {
  const known = (PRINT_VARIABLES as Record<string, string | undefined>)[path];
  return known ? `${known}（${path}）` : path;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "操作失败，请稍后重试";
}

function timeText(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

export function PrintTemplateEditor({ templateId }: { templateId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const canHtmlTemplate = useCan("print.template.publish.html");
  const [layout, setLayout] = useState<PrintTemplateLayout | null>(null);
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [preview, setPreview] = useState<PrintPreviewArtifact | null>(null);
  const [quoteId, setQuoteId] = useState<string>("");

  const detail = useQuery({
    queryKey: ["print-template", templateId],
    queryFn: () => api.printTemplate(templateId),
  });

  const quotes = useQuery({
    queryKey: ["quotes", "confirmed-for-print"],
    queryFn: () => api.quotes({ limit: 50 }),
  });

  const confirmedQuotes = useMemo(
    () =>
      (quotes.data?.items ?? []).filter(
        (quote) => quote.status === "SENT" || quote.status === "ACCEPTED",
      ),
    [quotes.data],
  );

  useEffect(() => {
    if (!detail.data || dirty) return;
    setLayout(detail.data.draft?.layout ?? detail.data.template.activeVersion?.layout ?? null);
  }, [detail.data, dirty]);

  useEffect(() => {
    if (!quoteId && confirmedQuotes[0]) setQuoteId(confirmedQuotes[0].id);
  }, [quoteId, confirmedQuotes]);

  const refresh = (next: PrintTemplateDetail) => {
    queryClient.setQueryData(["print-template", templateId], next);
    void queryClient.invalidateQueries({ queryKey: ["print", "templates"] });
  };

  const save = useMutation({
    mutationFn: (value: PrintTemplateLayout) =>
      api.savePrintTemplateDraft(templateId, { layout: value }),
    onSuccess: (next) => {
      refresh(next);
      setDirty(false);
      setFeedback("草稿已保存：正式打印仍用上一个发布版本");
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const publish = useMutation({
    mutationFn: (value: PrintTemplateLayout) =>
      api.publishPrintTemplateVersion(templateId, {
        layout: value,
        changelog: "可视化编辑发布",
      }),
    onSuccess: async () => {
      setFeedback("已发布新版本：之后的打印都用它");
      setDirty(false);
      const next = await api.printTemplate(templateId);
      refresh(next);
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const rollback = useMutation({
    mutationFn: (versionId: string) => api.activatePrintTemplateVersion(templateId, versionId),
    onSuccess: (next) => {
      refresh(next);
      setLayout(next.draft?.layout ?? next.template.activeVersion?.layout ?? null);
      setDirty(false);
      setFeedback("已切回该版本：新打印从这一版出纸");
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      api.previewTemplateSampleCard(templateId, { quoteId, lineIndex: 0, format: "HTML" }),
    onSuccess: (artifact) => {
      setPreview(artifact);
      setFeedback(null);
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const testPrint = useMutation({
    mutationFn: () =>
      api.testPrintTemplate(templateId, { quoteId, lineIndex: 0, format: "HTML", copies: 1 }),
    onSuccess: () => setFeedback("已入队试打：真的会出纸，但不计入正式打印记录"),
    onError: (error) => setFeedback(errorText(error)),
  });

  if (detail.isLoading) {
    return (
      <div className="flex min-h-60 items-center justify-center">
        <Spinner label="正在读取模板…" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        模板读不到：{detail.isError ? errorText(detail.error) : "不存在"}
      </div>
    );
  }

  const data = detail.data;
  const template = data.template;
  const pdfHref = preview?.pdfBase64 ? `data:application/pdf;base64,${preview.pdfBase64}` : null;
  // HTML 正文会进 headless Chromium 渲染，后端只允许 OWNER 保存/发布；界面同步禁用。
  const htmlLocked = template.format === "HTML" && !canHtmlTemplate;
  const busy = save.isPending || publish.isPending || rollback.isPending || htmlLocked;

  const updateBlock = (index: number, patch: Partial<PrintLayoutBlock>) => {
    if (!layout) return;
    const blocks = layout.blocks.map((block, i) => (i === index ? { ...block, ...patch } : block));
    setLayout({ ...layout, blocks });
    setDirty(true);
  };

  return (
    <div className="grid gap-4 pb-8">
      <header className="grid gap-2">
        <nav className="flex items-center gap-1 text-xs text-ink-400">
          <Link href="/resources" className="hover:text-ink-900">
            资源
          </Link>
          <span>/</span>
          <Link href="/resources/templates" className="hover:text-ink-900">
            模板
          </Link>
          <span>/</span>
          <span className="text-ink-700">{template.name}</span>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold text-ink-900">{template.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
            <Badge tone="neutral">{FORMAT_LABEL[template.format]}</Badge>
            {dirty ? <Badge tone="warning">未保存</Badge> : null}
            <Badge tone={data.draft ? "warning" : "success"}>
              {data.draft ? "有草稿（未发布）" : "已发布"}
            </Badge>
            <span>
              当前 v{template.activeVersion?.version ?? "—"} ·{" "}
              {template.activeVersion
                ? `发布 ${timeText(template.activeVersion.publishedAt)}`
                : "未发布"}
            </span>
          </div>
        </div>
        <p className="text-sm text-ink-400">
          改版式只影响新版本；已经用旧版本打出去的样卡不会被改写。试打真实但不算正式记录。
        </p>
      </header>

      {htmlLocked ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          A4（HTML）版式会进入渲染宿主，只有老板能保存和发布；标签版式不受影响。
        </div>
      ) : null}

      {feedback ? (
        <div
          className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-700"
          role="status"
        >
          {feedback}
        </div>
      ) : null}

      {!layout ? (
        <div className="rounded-md border border-line bg-surface p-4 text-sm text-ink-700">
          这个模板还没有版式（可能是历史文本模板）。可以先用空白版式开始，再逐行添加字段；或回列表复制系统样卡。
          <div className="mt-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                save.mutate({
                  version: 1,
                  blocks: [],
                  qr: { visible: true, position: "RIGHT", sizeMm: 30 },
                })
              }
            >
              用空白版式开始
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <section className="grid gap-4">
            <div className="rounded-lg border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-ink-700">版式</h2>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    className="min-h-9 px-3"
                    disabled={busy || !dirty}
                    onClick={() => layout && save.mutate(layout)}
                  >
                    保存草稿
                  </Button>
                  <Button
                    variant="primary"
                    className="min-h-9 px-3"
                    disabled={busy || layout.blocks.length === 0}
                    onClick={() => layout && publish.mutate(layout)}
                  >
                    发布新版本
                  </Button>
                </div>
              </div>

              <ul className="mt-3 grid gap-2">
                {layout.blocks.map((block, index) => (
                  <li
                    key={`${block.field}-${index}`}
                    className={`grid items-start gap-2 rounded-md border p-2 md:grid-cols-[auto_minmax(0,1fr)_8rem_auto] ${
                      block.visible ? "border-line" : "border-dashed border-line opacity-60"
                    }`}
                  >
                    <div className="flex items-center gap-2 md:pt-2">
                      <input
                        type="checkbox"
                        aria-label={`显示 ${fieldLabel(block.field)}`}
                        checked={block.visible}
                        onChange={(event) => updateBlock(index, { visible: event.target.checked })}
                      />
                      <span className="text-xs text-ink-400">#{index + 1}</span>
                    </div>
                    <div className="grid gap-1">
                      <select
                        aria-label={`第 ${index + 1} 行字段`}
                        className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm"
                        value={block.field}
                        onChange={(event) => updateBlock(index, { field: event.target.value })}
                      >
                        {FIELD_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={`第 ${index + 1} 行标签`}
                        className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm"
                        placeholder="行首标签（可空，如「成分」）"
                        value={block.label ?? ""}
                        onChange={(event) =>
                          updateBlock(index, { label: event.target.value || null })
                        }
                      />
                    </div>
                    <div className="flex items-center gap-1 whitespace-nowrap">
                      <label className="text-xs text-ink-400" htmlFor={`size-${index}`}>
                        字号
                      </label>
                      <input
                        id={`size-${index}`}
                        type="number"
                        min={8}
                        max={48}
                        className="min-h-9 w-16 rounded-md border border-line bg-surface px-2 text-sm"
                        value={block.fontSize}
                        onChange={(event) =>
                          updateBlock(index, {
                            fontSize: Math.min(48, Math.max(8, Number(event.target.value) || 12)),
                          })
                        }
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-1 md:justify-end">
                      <label className="flex items-center gap-1 text-xs text-ink-400">
                        <input
                          type="checkbox"
                          checked={block.bold}
                          onChange={(event) => updateBlock(index, { bold: event.target.checked })}
                        />
                        加粗
                      </label>
                      <button
                        type="button"
                        aria-label="上移"
                        className="min-h-9 rounded-md border border-line px-2 text-xs"
                        onClick={() => {
                          setLayout({ ...layout, blocks: move(layout.blocks, index, -1) });
                          setDirty(true);
                        }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label="下移"
                        className="min-h-9 rounded-md border border-line px-2 text-xs"
                        onClick={() => {
                          setLayout({ ...layout, blocks: move(layout.blocks, index, 1) });
                          setDirty(true);
                        }}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label="删除这一行"
                        className="min-h-9 rounded-md border border-line px-2 text-xs text-vermilion-600"
                        onClick={() => {
                          setLayout({
                            ...layout,
                            blocks: layout.blocks.filter((_, i) => i !== index),
                          });
                          setDirty(true);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select
                  aria-label="添加字段"
                  className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm"
                  defaultValue=""
                  onChange={(event) => {
                    const field = event.target.value;
                    if (!field) return;
                    setLayout({
                      ...layout,
                      blocks: [
                        ...layout.blocks,
                        { field, label: null, visible: true, fontSize: 14, bold: false },
                      ],
                    });
                    setDirty(true);
                    event.target.value = "";
                  }}
                >
                  <option value="">＋ 添加字段…</option>
                  {FIELD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-sm font-medium text-ink-700">二维码</h2>
              <div className="mt-2 flex flex-wrap items-end gap-3">
                <label className="flex min-h-9 items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={layout.qr.visible}
                    onChange={(event) => {
                      setLayout({
                        ...layout,
                        qr: { ...layout.qr, visible: event.target.checked },
                      });
                      setDirty(true);
                    }}
                  />
                  显示二维码
                </label>
                <label className="grid gap-1 text-xs text-ink-400">
                  位置
                  <select
                    className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
                    value={layout.qr.position}
                    onChange={(event) => {
                      setLayout({
                        ...layout,
                        qr: {
                          ...layout.qr,
                          position: event.target.value as PrintTemplateLayout["qr"]["position"],
                        },
                      });
                      setDirty(true);
                    }}
                  >
                    <option value="RIGHT">右侧</option>
                    <option value="LEFT">左侧</option>
                    <option value="TOP">上方</option>
                    <option value="BOTTOM">下方</option>
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-ink-400">
                  尺寸（mm）
                  <input
                    type="number"
                    min={16}
                    max={60}
                    className="min-h-9 w-24 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
                    value={layout.qr.sizeMm}
                    onChange={(event) => {
                      setLayout({
                        ...layout,
                        qr: {
                          ...layout.qr,
                          sizeMm: Math.min(60, Math.max(16, Number(event.target.value) || 30)),
                        },
                      });
                      setDirty(true);
                    }}
                  />
                </label>
                <p className="text-xs text-ink-400">
                  二维码只指向公开页（样品编号 + 业务员联系方式），不含价格与客户名。
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-sm font-medium text-ink-700">版本</h2>
              <p className="mt-1 text-xs text-ink-400">
                版本只增不改：要改就发新版本；回滚只是把「当前版本」指回旧版本。
              </p>
              <ul className="mt-3 grid gap-2">
                {data.versions.length === 0 ? (
                  <li className="text-sm text-ink-400">还没有发布版本。</li>
                ) : null}
                {data.versions.map((version) => {
                  const active = version.id === template.activeVersion?.id;
                  return (
                    <li
                      key={version.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
                    >
                      <div className="grid gap-0.5">
                        <span className="font-medium text-ink-900">
                          v{version.version}
                          {active ? " · 当前使用" : ""}
                        </span>
                        <span className="text-xs text-ink-400">
                          发布 {timeText(version.publishedAt)} · 已打印 {version.printCount} 次
                          {version.changelog ? ` · ${version.changelog}` : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 md:pt-2">
                        <details className="text-xs text-ink-400">
                          <summary className="cursor-pointer">查看版式</summary>
                          <pre className="mt-1 max-h-40 max-w-md overflow-auto rounded bg-paper p-2 text-[10px] leading-tight">
                            {version.layout
                              ? version.layout.blocks
                                  .filter((block) => block.visible)
                                  .map((block) => `${block.label ?? ""} {{${block.field}}}`)
                                  .join("\n")
                              : version.body}
                          </pre>
                        </details>
                        <Button
                          variant="secondary"
                          className="min-h-9 px-3"
                          disabled={active || busy}
                          onClick={() => rollback.mutate(version.id)}
                        >
                          {active ? "使用中" : "切回这一版"}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          <aside className="grid gap-3 self-start">
            <div className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-sm font-medium text-ink-700">真实数据预览</h2>
              <p className="mt-1 text-xs text-ink-400">
                选一份已确认的报价：预览和试打都用它的真实样品数据，草稿也会一并渲染。
              </p>
              <select
                aria-label="选择报价"
                className="mt-2 min-h-9 w-full rounded-md border border-line bg-surface px-2 text-sm"
                value={quoteId}
                onChange={(event) => setQuoteId(event.target.value)}
              >
                {confirmedQuotes.length === 0 ? <option value="">没有已确认的报价</option> : null}
                {confirmedQuotes.map((quote) => (
                  <option key={quote.id} value={quote.id}>
                    {quote.customerName} · {quote.status === "ACCEPTED" ? "客户已接受" : "已发送"}
                  </option>
                ))}
              </select>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  className="min-h-9 px-3"
                  disabled={!quoteId || previewMutation.isPending}
                  onClick={() => previewMutation.mutate()}
                >
                  {previewMutation.isPending ? "渲染中…" : "预览"}
                </Button>
                <Button
                  variant="primary"
                  className="min-h-9 px-3"
                  disabled={!quoteId || testPrint.isPending}
                  onClick={() => testPrint.mutate()}
                >
                  {testPrint.isPending ? "发送中…" : "试打一张"}
                </Button>
              </div>
              {feedback && testPrint.isSuccess ? (
                <p className="mt-2 text-xs text-moss-600">已入队试打，不计入正式打印记录。</p>
              ) : null}
            </div>

            <div className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-sm font-medium text-ink-700">预览产物</h2>
              {!preview ? (
                <p className="mt-2 text-xs text-ink-400">
                  还没有预览。预览用的就是打印会用的那一份。
                </p>
              ) : preview.format === "HTML" ? (
                <div className="mt-2 grid gap-2">
                  {/* 预览的是服务端渲染的样卡 HTML：禁脚本/表单/同源，只当静态画布看。 */}
                  <iframe
                    title="样卡预览"
                    className="h-96 w-full rounded-md border border-line bg-white"
                    sandbox=""
                    srcDoc={preview.html ?? ""}
                  />
                  {pdfHref ? (
                    <a
                      className="text-xs text-indigo-600 underline"
                      href={pdfHref}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开打印用 PDF
                    </a>
                  ) : null}
                </div>
              ) : (
                <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-paper p-2 text-[10px] leading-tight">
                  {preview.text}
                </pre>
              )}
              {preview ? (
                <ul className="mt-2 grid gap-0.5 text-xs text-ink-400">
                  {preview.fields.map((field) => (
                    <li key={field.path}>
                      {field.label}：{field.value || "—"}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
