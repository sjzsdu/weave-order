"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PrintJob,
  PrintTemplateFormat,
  ReprintReason,
} from "@weave-order/schema";
import { Badge, Button, Card, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";

/**
 * 独立样品标签：样品本身就是要打印的单据，不依赖报价。
 * 预览返回的就是入队后交给打印代理的字节，不允许前端另画一份。
 */

const FORMAT_OPTIONS: Array<{ value: PrintTemplateFormat; label: string; hint: string }> = [
  { value: "ZPL", label: "80×50 标签", hint: "斑马 / ZPL 热敏机" },
  { value: "TSPL", label: "80×50 标签", hint: "TSC / TSPL 热敏机" },
  { value: "HTML", label: "A4 样卡", hint: "办公室 A4 打印机" },
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

export function SampleLabelPrintDrawer({
  sampleId,
  sampleName,
  onClose,
}: {
  sampleId: string;
  sampleName?: string;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [format, setFormat] = useState<PrintTemplateFormat>("ZPL");
  const [copies, setCopies] = useState(1);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reprintReason, setReprintReason] = useState<ReprintReason>("DAMAGED");
  const [reprintTarget, setReprintTarget] = useState<PrintJob | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const previewQuery = useQuery({
    queryKey: ["sample-label-preview", sampleId, format],
    queryFn: () => api.previewSampleLabel(sampleId, { format }),
    retry: false,
    gcTime: 0,
  });

  const jobsQuery = useQuery({
    queryKey: ["sample-label-jobs", sampleId],
    queryFn: () => api.sampleLabelJobs(sampleId),
  });

  const print = useMutation({
    mutationFn: () => api.printSampleLabel(sampleId, { format, copies }),
    onSuccess: (result) => {
      setFeedback(
        result.deduplicated
          ? "已在队列：不会重复出纸"
          : `已入队 1 张样品标签 × ${copies} 份，代理在线会自动打印`,
      );
      void queryClient.invalidateQueries({ queryKey: ["sample-label-jobs", sampleId] });
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const reprint = useMutation({
    mutationFn: (job: PrintJob) =>
      api.reprintSampleLabel(sampleId, {
        reason: reprintReason,
        format: job.format,
        copies: 1,
      }),
    onSuccess: () => {
      setFeedback("已补打：不会新增样品");
      setReprintTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["sample-label-jobs", sampleId] });
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const preview = previewQuery.data;
  const pdfHref = preview?.pdfBase64
    ? `data:application/pdf;base64,${preview.pdfBase64}`
    : null;

  return (
    <div>
      <button
        type="button"
        aria-label="关闭样品标签打印"
        onClick={onClose}
        className="fixed inset-0 z-[60] bg-ink-900/20"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="打印样品标签"
        className="fixed inset-y-0 right-0 z-[61] flex w-full max-w-[560px] flex-col border-l border-line bg-surface shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">打印样品标签</h2>
            <p className="mt-0.5 text-xs text-ink-400">
              {sampleName || sampleId} · 直接按样品出纸，不需要报价
            </p>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="关闭">
            ✕
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <Card className="p-3">
            <p className="text-xs font-medium text-ink-700">标签版式</p>
            <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="标签版式">
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

            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_8rem]">
              <div className="rounded-md border border-line bg-paper p-2">
                {previewQuery.isPending ? (
                  <div className="flex min-h-40 items-center justify-center">
                    <Spinner />
                  </div>
                ) : previewQuery.isError ? (
                  <p className="p-3 text-sm text-red-700" role="alert">
                    不能生成样品标签：{errorText(previewQuery.error)}
                  </p>
                ) : preview ? (
                  preview.format === "HTML" ? (
                    <iframe
                      title="样品标签打印产物（A4 PDF）"
                      src={pdfHref ?? preview.html ?? undefined}
                      srcDoc={pdfHref ? undefined : (preview.html ?? "")}
                      className="h-[420px] w-full rounded bg-white"
                    />
                  ) : (
                    <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap p-2 text-xs text-ink-700">
                      {preview.text}
                    </pre>
                  )
                ) : null}
              </div>

              <div className="grid content-start gap-3">
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
                  variant="primary"
                  className="min-h-11 w-full"
                  disabled={print.isPending || !preview}
                  onClick={() => print.mutate()}
                >
                  {print.isPending ? "正在入队…" : "打印"}
                </Button>
                {pdfHref ? (
                  <a
                    className="text-center text-xs underline decoration-dotted underline-offset-2"
                    href={pdfHref}
                    download={`sample-label-${preview?.sampleCode}.pdf`}
                  >
                    下载 A4 PDF
                  </a>
                ) : null}
              </div>
            </div>

            {feedback ? (
              <p className="mt-3 text-sm text-ink-700" role="status">
                {feedback}
              </p>
            ) : null}
            {preview ? (
              <div className="mt-3 border-t border-line pt-3">
                <p className="text-xs font-medium text-ink-700">卡面字段</p>
                <dl className="mt-2 grid gap-1 text-xs">
                  {preview.fields.map((field) => (
                    <div key={field.path} className="flex justify-between gap-2">
                      <dt className="text-ink-400">{field.label}</dt>
                      <dd className="truncate text-ink-900" title={field.value}>
                        {field.value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-2 text-xs text-ink-400">二维码：{preview.qrPayload}</p>
              </div>
            ) : null}
          </Card>

          <div className="mt-4">
            <h3 className="text-sm font-medium text-ink-700">打印记录</h3>
            {jobsQuery.isPending ? (
              <p className="mt-2 flex items-center gap-2 text-xs text-ink-400">
                <Spinner /> 读取中…
              </p>
            ) : (jobsQuery.data?.length ?? 0) === 0 ? (
              <p className="mt-2 text-xs text-ink-400">还没有打印过这张样品标签。</p>
            ) : (
              <ul className="mt-2 grid gap-2">
                {(jobsQuery.data ?? []).map((job) => (
                  <li
                    key={job.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-xs"
                  >
                    <span className="flex flex-wrap items-center gap-2 text-ink-700">
                      <Badge tone={JOB_STATUS_TONE[job.status]}>{JOB_STATUS_LABEL[job.status]}</Badge>
                      <span>{job.format === "HTML" ? "A4 样卡" : `${job.format} 标签`}</span>
                      <span className="text-ink-400">
                        {job.copies} 份 · {timeText(job.createdAt)}
                      </span>
                      {job.reprintReason ? <span className="text-ink-400">补打</span> : null}
                    </span>
                    {reprintTarget?.id === job.id ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <select
                          aria-label="补打原因"
                          value={reprintReason}
                          onChange={(event) =>
                            setReprintReason(event.target.value as ReprintReason)
                          }
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
              <p className="mt-2 text-sm text-red-600">{errorText(jobsQuery.error)}</p>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}
