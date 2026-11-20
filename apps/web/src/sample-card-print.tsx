"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PrintJob,
  PrintPreviewArtifact,
  PrintTemplateFormat,
  ReprintReason,
} from "@weave-order/schema";
import { Badge, Button, Card, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";

/**
 * 打印样卡（P0b）。
 *
 * 报价确认之后才会出现：一张样卡只会跟着「已定稿」的报价流出去。
 * 预览用的是后端打印时用的同一份产物（A4 是同一份 PDF，标签是同一段指令），
 * 因此这里不重复实现排版，也不给「预览好看、纸上不一样」留空间。
 */

type CardFormat = PrintTemplateFormat;

const FORMAT_OPTIONS: Array<{ value: CardFormat; label: string; hint: string }> = [
  { value: "HTML", label: "A4 样卡", hint: "办公室 A4 打印机" },
  { value: "ZPL", label: "80×50 标签", hint: "斑马 / ZPL 热敏机" },
  { value: "TSPL", label: "80×50 标签", hint: "TSC / TSPL 热敏机" },
];

const REPRINT_REASONS: Array<{ value: ReprintReason; label: string }> = [
  { value: "DAMAGED", label: "破损" },
  { value: "LOST", label: "丢失" },
  { value: "CUSTOMER_REQUEST", label: "客户要求重打" },
  { value: "WRONG_PRINT", label: "打错了" },
  { value: "OTHER", label: "其它" },
];

const JOB_STATUS_LABEL: Record<PrintJob["status"], string> = {
  QUEUED: "排队中",
  SENT: "已下发",
  PRINTING: "打印中",
  DONE: "已打印",
  FAILED: "失败",
  CANCELLED: "已取消",
};

const JOB_STATUS_TONE: Record<PrintJob["status"], "neutral" | "warning" | "success" | "danger"> = {
  QUEUED: "neutral",
  SENT: "warning",
  PRINTING: "warning",
  DONE: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
};

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "操作失败，请稍后重试";
}

function timeText(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SampleCardPrint({ quoteId }: { quoteId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<CardFormat>("HTML");
  // 默认看版式；「打印 PDF」标签页里的才是真正入队的那份文件。
  const [previewTab, setPreviewTab] = useState<"layout" | "artifact">("layout");
  const [copies, setCopies] = useState(1);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reprintReason, setReprintReason] = useState<ReprintReason>("DAMAGED");
  const [reprintTarget, setReprintTarget] = useState<PrintJob | null>(null);

  const previewQuery = useQuery({
    queryKey: ["sample-card-preview", quoteId, format],
    queryFn: () => api.previewSampleCard({ quoteId, format }),
    enabled: open,
    retry: false,
    gcTime: 0,
  });

  const jobsQuery = useQuery({
    queryKey: ["sample-card-jobs", quoteId],
    queryFn: () => api.sampleCardJobs(quoteId),
    enabled: open,
  });

  const print = useMutation({
    mutationFn: () => api.printSampleCards(quoteId, { format, copies }),
    onSuccess: (result) => {
      setFeedback(
        result.deduplicated.length > 0
          ? "已在队列：不会重复出纸"
          : `已入队 ${result.jobs.length} 张样卡，代理在线会自动打印`,
      );
      void queryClient.invalidateQueries({ queryKey: ["sample-card-jobs", quoteId] });
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const reprint = useMutation({
    mutationFn: (job: PrintJob) =>
      api.reprintSampleCard(quoteId, {
        reason: reprintReason,
        lineIndex: Math.max((job.labelSeq ?? 1) - 1, 0),
        format: job.format,
        copies: 1,
      }),
    onSuccess: () => {
      setFeedback("已补打：不会新增样品");
      setReprintTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["sample-card-jobs", quoteId] });
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const preview: PrintPreviewArtifact | undefined = previewQuery.data;
  const pdfHref = useMemo(
    () => (preview?.pdfBase64 ? `data:application/pdf;base64,${preview.pdfBase64}` : null),
    [preview?.pdfBase64],
  );

  if (!open) {
    return (
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-ink-700">打印样卡</h2>
            <p className="mt-1 text-xs text-ink-400">
              价格已确认：可以出 A4 样卡或 80×50mm 热敏标签，扫码只看样品编号与业务员联系方式。
            </p>
          </div>
          <Button variant="secondary" className="min-h-11" onClick={() => setOpen(true)}>
            打印样卡
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-ink-700">打印样卡</h2>
        <Button variant="secondary" className="min-h-11" onClick={() => setOpen(false)}>
          收起
        </Button>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_18rem]">
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="样卡版面">
            {FORMAT_OPTIONS.map((option) => (
              <button
                key={`${option.value}-${option.label}`}
                type="button"
                role="radio"
                aria-checked={format === option.value}
                onClick={() => setFormat(option.value)}
                className={`min-h-11 rounded-md border px-3 text-left text-sm ${
                  format === option.value
                    ? "border-ink-900 bg-paper text-ink-900"
                    : "border-line bg-surface text-ink-700"
                }`}
              >
                <span className="block font-medium">{option.label}</span>
                <span className="block text-xs text-ink-400">{option.hint}</span>
              </button>
            ))}
          </div>

          {previewQuery.isPending ? (
            <div className="flex min-h-40 items-center justify-center rounded-md border border-line">
              <Spinner />
            </div>
          ) : previewQuery.isError ? (
            <div
              className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
              role="alert"
            >
              不能生成样卡：{errorText(previewQuery.error)}
            </div>
          ) : preview ? (
            <div className="grid gap-3">
              <div className="rounded-md border border-line bg-paper p-2">
                {preview.format === "HTML" ? (
                  <div className="grid gap-2">
                    <div className="flex gap-2 text-xs" role="tablist" aria-label="预览方式">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={previewTab === "layout"}
                        onClick={() => setPreviewTab("layout")}
                        className={`min-h-9 rounded-md border px-3 ${
                          previewTab === "layout"
                            ? "border-ink-900 bg-surface text-ink-900"
                            : "border-line text-ink-400"
                        }`}
                      >
                        版式预览
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={previewTab === "artifact"}
                        onClick={() => setPreviewTab("artifact")}
                        className={`min-h-9 rounded-md border px-3 ${
                          previewTab === "artifact"
                            ? "border-ink-900 bg-surface text-ink-900"
                            : "border-line text-ink-400"
                        }`}
                      >
                        打印 PDF
                      </button>
                    </div>
                    {previewTab === "layout" ? (
                      <iframe
                        title="样卡版式预览（A4）"
                        srcDoc={preview.html ?? ""}
                        className="h-[520px] w-full rounded bg-white"
                        sandbox=""
                      />
                    ) : (
                      // 这份 PDF 就是入队后打印代理收到的那份文件（同一串 base64）。
                      <iframe
                        title="样卡打印产物（A4 PDF）"
                        src={pdfHref ?? undefined}
                        className="h-[520px] w-full rounded bg-white"
                      />
                    )}
                  </div>
                ) : (
                  <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap p-2 text-xs text-ink-700">
                    {preview.text}
                  </pre>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                <span>
                  模板：{preview.templateName}
                  {preview.pageSize ? ` · ${preview.pageSize}` : ""}
                </span>
                {pdfHref ? (
                  <a
                    className="underline decoration-dotted underline-offset-2"
                    href={pdfHref}
                    download={`sample-card-${preview.sampleCode}.pdf`}
                  >
                    下载 A4 PDF（与打印产物同一份）
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="grid content-start gap-3">
          <div className="rounded-md border border-line p-3">
            <label className="grid gap-1 text-sm text-ink-700">
              <span>份数</span>
              <input
                type="number"
                min={1}
                max={20}
                value={copies}
                onChange={(event) =>
                  setCopies(Math.max(1, Math.min(20, Number(event.target.value) || 1)))
                }
                className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
              />
            </label>
            <Button
              className="mt-3 min-h-11 w-full"
              variant="primary"
              disabled={print.isPending || !preview}
              onClick={() => print.mutate()}
            >
              {print.isPending ? "正在入队…" : "打印"}
            </Button>
            <p className="mt-2 text-xs text-ink-400">
              同一张卡重复点击不会重复出纸；换人、换模板或补打才生成新任务。
            </p>
            {feedback ? (
              <p className="mt-2 text-xs text-ink-700" role="status">
                {feedback}
              </p>
            ) : null}
          </div>

          <div className="rounded-md border border-line p-3">
            <h3 className="text-sm font-medium text-ink-700">预览字段</h3>
            <dl className="mt-2 grid gap-1 text-xs">
              {(preview?.fields ?? []).map((field) => (
                <div key={field.path} className="flex justify-between gap-2">
                  <dt className="text-ink-400">{field.label}</dt>
                  <dd className="truncate text-ink-900" title={field.value}>
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-ink-400">
              二维码内容：{preview ? `${preview.qrPayload.slice(0, 12)}…` : "—"}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <h3 className="text-sm font-medium text-ink-700">打印记录</h3>
        {jobsQuery.isPending ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-ink-400">
            <Spinner /> 读取中…
          </div>
        ) : (jobsQuery.data?.length ?? 0) === 0 ? (
          <p className="mt-2 text-xs text-ink-400">还没有打印过这张样卡。</p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {(jobsQuery.data ?? []).map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-xs"
              >
                <span className="flex items-center gap-2 text-ink-700">
                  <Badge tone={JOB_STATUS_TONE[job.status]}>{JOB_STATUS_LABEL[job.status]}</Badge>
                  <span>{job.format === "HTML" ? "A4 样卡" : `${job.format} 标签`}</span>
                  <span className="text-ink-400">
                    第 {job.labelSeq ?? 1} 张 · {job.copies} 份 · {timeText(job.createdAt)}
                  </span>
                  {job.reprintReason ? <span className="text-ink-400">补打</span> : null}
                </span>
                {reprintTarget?.id === job.id ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="补打原因"
                      value={reprintReason}
                      onChange={(event) => setReprintReason(event.target.value as ReprintReason)}
                      className="min-h-9 rounded-md border border-line bg-surface px-2 text-xs"
                    >
                      {REPRINT_REASONS.map((reason) => (
                        <option key={reason.value} value={reason.value}>
                          {reason.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="primary"
                      className="min-h-9"
                      disabled={reprint.isPending}
                      onClick={() => reprint.mutate(job)}
                    >
                      {reprint.isPending ? "补打中…" : "确认补打"}
                    </Button>
                    <Button
                      variant="secondary"
                      className="min-h-9"
                      onClick={() => setReprintTarget(null)}
                    >
                      取消
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    className="min-h-9"
                    onClick={() => {
                      setReprintTarget(job);
                      setFeedback(null);
                    }}
                  >
                    补打
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {jobsQuery.isError ? (
          <p className="mt-2 text-xs text-red-600">{errorText(jobsQuery.error)}</p>
        ) : null}
      </div>
    </Card>
  );
}
