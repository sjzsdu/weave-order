"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { newClientRequestId, useCustomers } from "@weave-order/core";
import type {
  InboundDetail,
  InboundFieldCard,
  InboundTask,
  IntentKind,
  JsonValue,
} from "@weave-order/schema";
import { Badge, Button, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";

const KIND_LABEL: Record<string, string> = {
  quote: "报价",
  sample: "建样品",
  customer: "建客户",
  unknown: "待确认",
};

const TASK_LINK: Record<string, (id: string) => string> = {
  customer: (id) => `/panorama/customers/${id}/review`,
  sample: (id) => `/panorama/samples/${id}/review`,
  quote: (id) => `/items/${id}`,
  item: (id) => `/items/${id}`,
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

interface PendingFile {
  file: File;
  kind: "auto" | "bizcard" | "label" | "document";
}

function mimeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function sourceLabel(card: InboundFieldCard): string {
  if (card.sourceKind === "manual") return "人工";
  if (card.sourceKind === "bizcard") return "名片 OCR";
  if (card.sourceKind === "label") return "标签 OCR";
  if (card.sourceKind === "history") return "历史";
  return "模型";
}

function valueText(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value === null ? "" : JSON.stringify(value);
}

/**
 * 统一输入框（P0a-3）。
 *
 * 一次提交 = 一段话 + 多附件；服务端先出理解卡，用户确认或纠正后才执行。
 * 所有「识别」都以出处标注：OCR / 人工 / 历史；未识别字段留空高亮，不预填猜测值。
 */
export function InboundComposer({
  initialText = "",
  initialContext,
  autoFocus = false,
}: {
  initialText?: string;
  initialContext?: Record<string, string>;
  /** 空状态「新建事项」跳进来：输入框为空，但光标要已就位。 */
  autoFocus?: boolean;
}) {
  const api = useApi();
  const customers = useCustomers(api, 100);
  const samples = useQuery({
    queryKey: ["inbound", "samples"],
    queryFn: () => api.listSamples(50),
  });
  const [text, setText] = useState(initialText);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inboundId, setInboundId] = useState<string | null>(null);
  const [kind, setKind] = useState<IntentKind>("unknown");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("meter");
  const [customerId, setCustomerId] = useState("");
  const [sampleId, setSampleId] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  const detail = useQuery({
    queryKey: ["inbound", inboundId],
    queryFn: () => api.inbound(inboundId!),
    enabled: Boolean(inboundId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1500;
      const working = data.intent.status === "QUEUED" || data.intent.status === "RUNNING";
      return working ? 1500 : false;
    },
  });

  useEffect(() => {
    const data = detail.data;
    if (!data?.understanding) return;
    setKind(data.understanding.kind);
    setEdits((current) => {
      const next = { ...current };
      for (const card of data.understanding!.fields) {
        if (!(card.fieldName in next)) next[card.fieldName] = valueText(card.value);
      }
      return next;
    });
    const q = data.understanding.slots.quantity;
    if (typeof q === "number") setQuantity(String(q));
    const u = data.understanding.slots.unit;
    if (typeof u === "string") setUnit(u);
    const c = data.understanding.slots.customerId;
    if (typeof c === "string") setCustomerId(c);
    const s = data.understanding.slots.sampleId;
    if (typeof s === "string") setSampleId(s);
  }, [detail.data]);

  const addFiles = useCallback((list: FileList | File[]) => {
    const accepted: PendingFile[] = [];
    for (const file of Array.from(list)) {
      const mime = mimeOf(file);
      if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(mime)) {
        setError(`不支持的文件类型：${file.name}`);
        continue;
      }
      accepted.push({ file, kind: mime === "application/pdf" ? "document" : "auto" });
    }
    if (accepted.length > 0) {
      setFiles((current) => [...current, ...accepted].slice(0, 20));
      setError(null);
    }
  }, []);

  const upload = async (pending: PendingFile, clientRequestId: string) => {
    const mimeType = mimeOf(pending.file) as
      "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
    const presigned = await api.presignImage({
      mimeType,
      byteSize: pending.file.size,
      purpose: "inbound",
    });
    const response = await fetch(presigned.uploadUrl, {
      method: "PUT",
      headers: presigned.headers,
      body: pending.file,
    });
    if (!response.ok) throw new Error(`附件上传失败（HTTP ${response.status}）`);
    return {
      objectKey: presigned.objectKey,
      mimeType,
      byteSize: pending.file.size,
      kind: pending.kind,
      clientRequestId,
    };
  };

  const submit = async () => {
    if (busy) return;
    if (text.trim().length === 0 && files.length === 0) {
      setError("写一句话或至少上传一张图片/PDF");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 同一次提交的所有附件共用同一个幂等键：断网重发 / 重复点击只会产生一条 inbound。
      const clientRequestId = newClientRequestId();
      const attachments = [];
      for (const pending of files) attachments.push(await upload(pending, clientRequestId));
      const result = await api.submitInbound({
        ...(text.trim() ? { text: text.trim() } : {}),
        source: "upload",
        clientRequestId,
        ...(initialContext && Object.keys(initialContext).length > 0
          ? { context: initialContext }
          : {}),
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((entry) => ({
                objectKey: entry.objectKey,
                mimeType: entry.mimeType,
                byteSize: entry.byteSize,
                kind: entry.kind,
              })),
            }
          : {}),
      });
      setInboundId(result.inboundId);
      setFiles([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const understanding = detail.data?.understanding ?? null;
  const changedFields = useMemo(() => {
    if (!understanding) return [];
    return understanding.fields
      .filter((card) => (edits[card.fieldName] ?? "") !== valueText(card.value))
      .map((card) => ({ fieldName: card.fieldName, value: edits[card.fieldName] ?? "" }));
  }, [edits, understanding]);

  const revise = async () => {
    if (!inboundId) return;
    setBusy(true);
    setError(null);
    try {
      await api.reviseInbound(inboundId, {
        kind,
        ...(kind === "quote"
          ? {
              slots: {
                customerId: customerId || null,
                sampleId: sampleId || null,
                quantity: quantity ? Number(quantity) : null,
                unit,
              },
            }
          : {}),
        ...(changedFields.length > 0 ? { fields: changedFields } : {}),
      });
      await detail.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "纠正失败");
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!inboundId) return;
    setBusy(true);
    setError(null);
    try {
      await api.startInbound(inboundId, {
        kind,
        ...(kind === "quote"
          ? {
              slots: {
                customerId: customerId || null,
                sampleId: sampleId || null,
                quantity: quantity ? Number(quantity) : null,
                unit,
              },
            }
          : {}),
        ...(changedFields.length > 0 ? { fields: changedFields } : {}),
      });
      await detail.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "执行失败");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setInboundId(null);
    setText("");
    setFiles([]);
    setEdits({});
    setError(null);
    setQuantity("");
    setCustomerId("");
    setSampleId("");
  };

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-medium text-ink-900">
              一段话 + 几张图，小织先理解再执行
            </h2>
            <p className="mt-1 text-sm text-ink-400">
              支持名片、面料标签、PDF。识别不清的字段会留空并标为待补，不会猜。
            </p>
          </div>
          <Badge tone="info">统一输入</Badge>
        </div>

        <textarea
          ref={pasteRef}
          autoFocus={autoFocus}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            if (event.clipboardData.files.length > 0) addFiles(event.clipboardData.files);
          }}
          rows={4}
          maxLength={4000}
          placeholder="例如：给青禾服饰报 32S 精梳棉 500 米的价格；附图是名片和标签"
          className="mt-3 w-full resize-y rounded-md border border-line bg-paper/40 px-3 py-2 text-sm text-ink-900 outline-none focus:border-indigo-600"
        />

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
          className={cn(
            "mt-3 rounded-md border border-dashed px-3 py-4 text-center text-sm",
            dragging ? "border-indigo-600 bg-indigo-600/5" : "border-line text-ink-400",
          )}
        >
          拖入图片 / PDF，或{" "}
          <button
            type="button"
            className="text-indigo-600 underline"
            onClick={() => inputRef.current?.click()}
          >
            选择文件
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </div>

        {files.length > 0 && (
          <ul className="mt-3 space-y-2">
            {files.map((pending, index) => (
              <li
                key={`${pending.file.name}-${index}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-ink-900">{pending.file.name}</span>
                <select
                  value={pending.kind}
                  onChange={(event) => {
                    const value = event.target.value as PendingFile["kind"];
                    setFiles((current) =>
                      current.map((entry, i) => (i === index ? { ...entry, kind: value } : entry)),
                    );
                  }}
                  className="rounded border border-line bg-paper/40 px-2 py-1 text-xs"
                >
                  <option value="auto">自动判断</option>
                  <option value="bizcard">名片</option>
                  <option value="label">面料标签</option>
                  <option value="document">文档</option>
                </select>
                <button
                  type="button"
                  className="text-xs text-ink-400 hover:text-vermilion-600"
                  onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-400">⌘/Ctrl + Enter 提交；图片直传对象存储，不进 JSON。</p>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "提交中…" : "发给小织"}
          </Button>
        </div>
        {error && (
          <p className="mt-3 rounded-md border border-vermilion-600/30 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
            {error}
          </p>
        )}
      </section>

      {inboundId && (
        <section className="rounded-lg border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-medium text-ink-900">理解卡</h3>
              {detail.data && <Badge tone="info">{detail.data.intent.statusLabel}</Badge>}
              {understanding && (
                <Badge tone={understanding.kind === "unknown" ? "warning" : "success"}>
                  {KIND_LABEL[understanding.kind] ?? understanding.kind}
                </Badge>
              )}
            </div>
            <button type="button" className="text-xs text-ink-400 underline" onClick={reset}>
              新输入
            </button>
          </div>

          {detail.isLoading && (
            <div className="mt-4 flex items-center gap-2 text-sm text-ink-400">
              <Spinner /> 正在识别附件并整理理解卡…
            </div>
          )}

          {detail.data && !understanding && detail.data.intent.status === "FAILED" && (
            <p className="mt-3 rounded-md border border-vermilion-600/30 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
              {detail.data.intent.failureReason ?? "这次没整理出来，原话和附件都还在。"}
            </p>
          )}

          {understanding && (
            <div className="mt-4 space-y-4">
              <p className="text-sm text-ink-900">{understanding.summary}</p>

              <label className="block text-xs text-ink-400">
                我理解的是
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as IntentKind)}
                  className="ml-2 rounded border border-line bg-paper/40 px-2 py-1 text-sm text-ink-900"
                >
                  <option value="quote">报价</option>
                  <option value="sample">建样品</option>
                  <option value="customer">建客户</option>
                  <option value="unknown">还不确定</option>
                </select>
              </label>

              {understanding.pendingQuestions.length > 0 && (
                <div className="rounded-md border border-amber-600/30 bg-amber-600/10 px-3 py-2">
                  <p className="text-xs font-medium text-amber-700">还要确认</p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-amber-700">
                    {understanding.pendingQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </div>
              )}

              {understanding.kind === "quote" && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="text-xs text-ink-400">
                    客户
                    <select
                      value={customerId}
                      onChange={(event) => setCustomerId(event.target.value)}
                      className="mt-1 w-full rounded border border-line bg-paper/40 px-2 py-1 text-sm text-ink-900"
                    >
                      <option value="">未选择</option>
                      {(customers.data ?? []).map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-ink-400">
                    样品
                    <select
                      value={sampleId}
                      onChange={(event) => setSampleId(event.target.value)}
                      disabled={samples.isPending}
                      className="mt-1 w-full rounded border border-line bg-paper/40 px-2 py-1 text-sm text-ink-900 disabled:opacity-60"
                    >
                      <option value="">{samples.isPending ? "加载中…" : "未选择"}</option>
                      {(samples.data ?? []).map((sample) => (
                        <option key={sample.id} value={sample.id}>
                          {sample.code} · {sample.name}
                        </option>
                      ))}
                    </select>
                    {samples.isError && (
                      <span className="mt-1 block text-xs text-vermilion-600">
                        样品列表加载失败
                        {samples.error instanceof Error ? `：${samples.error.message}` : ""}。
                        <button
                          type="button"
                          onClick={() => void samples.refetch()}
                          className="ml-1 underline underline-offset-2"
                        >
                          重试
                        </button>
                      </span>
                    )}
                    {!samples.isPending &&
                      !samples.isError &&
                      (samples.data?.length ?? 0) === 0 && (
                        <span className="mt-1 block text-xs text-ink-400">
                          还没有样品，
                          <Link
                            href="/panorama/samples?new=1"
                            className="underline underline-offset-2"
                          >
                            先建一个 →
                          </Link>
                        </span>
                      )}
                  </label>
                  <label className="text-xs text-ink-400">
                    数量
                    <div className="mt-1 flex gap-1">
                      <input
                        inputMode="decimal"
                        value={quantity}
                        onChange={(event) => setQuantity(event.target.value)}
                        className="w-full rounded border border-line bg-paper/40 px-2 py-1 text-sm text-ink-900"
                      />
                      <select
                        value={unit}
                        onChange={(event) => setUnit(event.target.value)}
                        className="rounded border border-line bg-paper/40 px-1 py-1 text-sm"
                      >
                        <option value="meter">米</option>
                        <option value="kilogram">公斤</option>
                        <option value="yard">码</option>
                        <option value="piece">件</option>
                      </select>
                    </div>
                  </label>
                </div>
              )}

              {understanding.fields.length > 0 && (
                <div className="overflow-hidden rounded-md border border-line">
                  <table className="w-full text-sm">
                    <thead className="bg-paper/60 text-xs text-ink-400">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">字段</th>
                        <th className="px-3 py-2 text-left font-medium">值</th>
                        <th className="px-3 py-2 text-left font-medium">出处</th>
                      </tr>
                    </thead>
                    <tbody>
                      {understanding.fields.map((card) => (
                        <tr key={card.fieldName} className="border-t border-line">
                          <td className="px-3 py-2 align-top text-ink-700">
                            {card.label}
                            {card.required && <span className="ml-1 text-vermilion-600">*</span>}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              value={edits[card.fieldName] ?? ""}
                              onChange={(event) =>
                                setEdits((current) => ({
                                  ...current,
                                  [card.fieldName]: event.target.value,
                                }))
                              }
                              placeholder={card.pending ? "待补（不预填猜测值）" : ""}
                              className={cn(
                                "w-full rounded border bg-transparent px-2 py-1 text-sm text-ink-900 outline-none",
                                card.pending
                                  ? "border-amber-600/50 bg-amber-600/5 placeholder:text-amber-700"
                                  : "border-line",
                              )}
                            />
                            {card.help && (
                              <p className="mt-1 text-xs text-amber-700">{card.help}</p>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-xs text-ink-400">
                            {sourceLabel(card)}
                            {card.status === "CONFLICT" && (
                              <span className="ml-1 text-vermilion-600">冲突</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {detail.data && detail.data.attachments.length > 0 && (
                <ul className="space-y-1 text-xs text-ink-400">
                  {detail.data.attachments.map((attachment) => (
                    <li key={attachment.sourceId}>
                      附件 {attachment.sourceId.slice(0, 8)} ·{" "}
                      {attachment.ocrStatus === "FAILED"
                        ? `没识别出来（${attachment.failureCode ?? "未知原因"}），已保留原件`
                        : `OCR ${attachment.ocrStatus === "SUCCEEDED" ? "完成" : "处理中"}`}
                    </li>
                  ))}
                </ul>
              )}

              {understanding.tasks.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-ink-400">执行任务</p>
                  <ul className="mt-1 space-y-1">
                    {understanding.tasks.map((task: InboundTask, index) => (
                      <li
                        key={`${task.kind}-${index}`}
                        className="flex flex-wrap items-center gap-2 text-sm"
                      >
                        <Badge
                          tone={
                            task.status === "SUCCEEDED"
                              ? "success"
                              : task.status === "FAILED"
                                ? "danger"
                                : task.status === "NEEDS_INPUT"
                                  ? "warning"
                                  : "neutral"
                          }
                        >
                          {task.status}
                        </Badge>
                        <span className="text-ink-700">{task.label}</span>
                        {task.resourceId && task.resourceType && (
                          <Link
                            href={TASK_LINK[task.resourceType]?.(task.resourceId) ?? "#"}
                            className="text-indigo-600 underline"
                          >
                            去确认
                          </Link>
                        )}
                        {task.message && (
                          <span className="text-xs text-ink-400">{task.message}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {detail.data?.canRevise !== false && (
                  <Button variant="secondary" onClick={() => void revise()} disabled={busy}>
                    改好了，重新整理
                  </Button>
                )}
                {detail.data?.canStart !== false && (
                  <Button variant="primary" onClick={() => void start()} disabled={busy}>
                    {busy ? "执行中…" : "确认并执行"}
                  </Button>
                )}
                {detail.data?.intent.draft && (
                  <span className="text-sm text-moss-600">
                    已产出「{detail.data.intent.draft.title}」，去上面的任务里确认。
                  </span>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export type { InboundDetail };
