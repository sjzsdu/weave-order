"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrintJob, PrintPreviewArtifact, ReprintReason } from "@weave-order/schema";
import { Badge, Button, Card, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";

/**
 * 独立样品标签：样品本身就是要打印的单据，不依赖报价。
 * 可视预览使用后端按实际模板生成的图元，打印仍使用同一次预览返回的标签指令。
 */

const PRINTER_STATUS_LABEL = {
  READY: "在线",
  OFFLINE: "离线",
  NEEDS_ATTENTION: "需处理",
} as const;

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

function LabelPreview({ preview }: { preview: NonNullable<PrintPreviewArtifact["labelPreview"]> }) {
  return (
    <svg
      aria-label="80×50mm 标签效果预览"
      className="block aspect-[8/5] w-full bg-white text-black"
      data-testid="sample-label-visual-preview"
      role="img"
      viewBox={`0 0 ${preview.width} ${preview.height}`}
    >
      {preview.elements.map((element, index) => {
        const key = `${element.type}-${element.x}-${index}`;
        if (element.type === "text") {
          return (
            <text
              key={key}
              dominantBaseline="text-before-edge"
              fill="currentColor"
              fontFamily="Arial, PingFang SC, Microsoft YaHei, sans-serif"
              fontSize={element.fontSize}
              fontWeight={element.bold ? 700 : 400}
              x={element.x}
              y={element.y}
            >
              {element.text}
            </text>
          );
        }
        if (element.type === "rect") {
          return (
            <rect
              key={key}
              fill="currentColor"
              height={element.height}
              width={element.width}
              x={element.x}
              y={element.y}
            />
          );
        }
        return (
          <image
            key={key}
            height={element.size}
            href={element.dataUrl}
            preserveAspectRatio="xMidYMid meet"
            width={element.size}
            x={element.x}
            y={element.y}
          />
        );
      })}
    </svg>
  );
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
  const [selectedPrinterId, setSelectedPrinterId] = useState("");
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

  const devicesQuery = useQuery({
    queryKey: ["print", "devices"],
    queryFn: () => api.printDevices(),
    refetchInterval: 8_000,
  });
  const labelPrinters = (devicesQuery.data?.printers ?? []).filter(
    (printer) => printer.kind !== "A4",
  );
  const selectedPrinter = labelPrinters.find((printer) => printer.id === selectedPrinterId);

  useEffect(() => {
    const available = (devicesQuery.data?.printers ?? []).filter(
      (printer) => printer.kind !== "A4",
    );
    if (selectedPrinterId && available.some((printer) => printer.id === selectedPrinterId)) {
      return;
    }
    const fallback = available.find((printer) => printer.status === "READY") ?? available[0];
    setSelectedPrinterId(fallback?.id ?? "");
  }, [devicesQuery.data, selectedPrinterId]);

  const previewQuery = useQuery({
    queryKey: ["sample-label-preview", sampleId, selectedPrinterId],
    queryFn: () => api.previewSampleLabel(sampleId, { printerId: selectedPrinterId }),
    enabled: Boolean(selectedPrinterId),
    retry: false,
    gcTime: 0,
  });

  const jobsQuery = useQuery({
    queryKey: ["sample-label-jobs", sampleId],
    queryFn: () => api.sampleLabelJobs(sampleId),
  });

  const print = useMutation({
    mutationFn: (input: { printerId: string; printerName: string; copies: number }) =>
      api.printSampleLabel(sampleId, { printerId: input.printerId, copies: input.copies }),
    onSuccess: (result, input) => {
      setFeedback(
        result.deduplicated
          ? `已在 ${input.printerName} 的队列：不会重复出纸`
          : `已入队到 ${input.printerName}：1 张样品标签 × ${input.copies} 份`,
      );
      void queryClient.invalidateQueries({ queryKey: ["sample-label-jobs", sampleId] });
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const reprint = useMutation({
    mutationFn: (input: { job: PrintJob; printerId: string; printerName: string }) =>
      api.reprintSampleLabel(sampleId, {
        reason: reprintReason,
        printerId: input.printerId,
        copies: 1,
      }),
    onSuccess: (_result, input) => {
      setFeedback(`已补打到 ${input.printerName}：不会新增样品`);
      setReprintTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["sample-label-jobs", sampleId] });
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const preview = previewQuery.data;

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
            <div className="mt-2 rounded-md border border-ink-900 bg-paper px-3 py-2 text-sm">
              <span className="block font-medium text-ink-900">80×50 标签</span>
              <span className="block text-xs text-ink-400">
                {preview
                  ? `${preview.format} · 由所选打印机自动匹配`
                  : "ZPL / TSPL 由所选打印机自动匹配"}
              </span>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_8rem]">
              <div className="min-w-0 overflow-hidden rounded-md border border-line bg-paper p-2">
                {devicesQuery.isPending ? (
                  <div className="flex min-h-40 items-center justify-center">
                    <Spinner />
                  </div>
                ) : devicesQuery.isError ? (
                  <p className="p-3 text-sm text-red-700" role="alert">
                    不能读取打印机：{errorText(devicesQuery.error)}
                  </p>
                ) : !selectedPrinter ? (
                  <p className="flex min-h-40 items-center justify-center p-3 text-center text-sm text-ink-400">
                    还没有标签打印机，请先在打印中心连接代理并上报打印机。
                  </p>
                ) : previewQuery.isPending ? (
                  <div className="flex min-h-40 items-center justify-center">
                    <Spinner />
                  </div>
                ) : previewQuery.isError ? (
                  <p className="p-3 text-sm text-red-700" role="alert">
                    不能生成样品标签：{errorText(previewQuery.error)}
                  </p>
                ) : preview ? (
                  <div>
                    {preview.labelPreview ? (
                      <div className="overflow-hidden rounded border border-line bg-white shadow-sm">
                        <LabelPreview preview={preview.labelPreview} />
                      </div>
                    ) : (
                      <p className="p-3 text-sm text-ink-700">
                        该手写指令模板暂不支持效果预览，请迁移为可视版式。
                      </p>
                    )}
                    <p className="mt-2 text-center text-xs text-ink-400">
                      {preview.format} · 80×50mm 标签效果预览
                    </p>
                    {preview.text ? (
                      <details className="mt-2 min-w-0 text-xs text-ink-700">
                        <summary className="cursor-pointer select-none">查看打印指令</summary>
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2">
                          {preview.text}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="grid min-w-0 content-start gap-3">
                <label className="grid min-w-0 gap-1 text-sm text-ink-700">
                  <span>打印机</span>
                  <select
                    aria-label="标签打印机"
                    className="min-h-11 w-full min-w-0 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
                    disabled={devicesQuery.isPending || labelPrinters.length === 0}
                    onChange={(event) => {
                      setSelectedPrinterId(event.target.value);
                      setFeedback(null);
                      setReprintTarget(null);
                    }}
                    value={selectedPrinterId}
                  >
                    {labelPrinters.length === 0 ? (
                      <option value="">无可用标签打印机</option>
                    ) : (
                      labelPrinters.map((printer) => (
                        <option key={printer.id} value={printer.id}>
                          {printer.name} · {PRINTER_STATUS_LABEL[printer.status]}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                {selectedPrinter && selectedPrinter.status !== "READY" ? (
                  <p className="text-xs text-ink-400">设备当前非在线，任务会排队等待代理恢复。</p>
                ) : null}
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
                    className="min-h-11 min-w-0 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
                  />
                </label>
                <Button
                  variant="primary"
                  className="min-h-11 w-full"
                  disabled={print.isPending || !preview || !selectedPrinter}
                  onClick={() => {
                    if (!selectedPrinter) return;
                    print.mutate({
                      printerId: selectedPrinter.id,
                      printerName: selectedPrinter.name,
                      copies,
                    });
                  }}
                >
                  {print.isPending ? "正在入队…" : "打印"}
                </Button>
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
                      <Badge tone={JOB_STATUS_TONE[job.status]}>
                        {JOB_STATUS_LABEL[job.status]}
                      </Badge>
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
                          disabled={reprint.isPending || !selectedPrinter}
                          onClick={() => {
                            if (!selectedPrinter) return;
                            reprint.mutate({
                              job,
                              printerId: selectedPrinter.id,
                              printerName: selectedPrinter.name,
                            });
                          }}
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
                        disabled={!selectedPrinter}
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
