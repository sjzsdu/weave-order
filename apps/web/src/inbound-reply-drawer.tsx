"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InboundReplyResult } from "@weave-order/schema";
import { Badge, Button, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { compressImageFile, uploadToPresignedUrl } from "@/image-compress";

type Mode = "manual" | "screenshot";

function newExternalId(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `web-${uuid}`.slice(0, 128);
}

function isSimulated(provider: string | undefined): boolean {
  return Boolean(provider && provider.startsWith("local-"));
}

/**
 * 录入客户回复：粘贴一段文本，或上传一张聊天截图（服务端用多模态模型 OCR）。
 *
 * 截图先压缩再直传对象存储（presign purpose=inbound），只把 objectKey 交给 API；
 * 识别与草稿生成都由服务端完成，前端只展示结果，不推导意图或金额。
 */
export function InboundReplyDrawer({
  open,
  customerId,
  customerName,
  onClose,
  onDone,
}: {
  open: boolean;
  customerId: string;
  customerName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("manual");
  const [text, setText] = useState("");
  const [sampleId, setSampleId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [externalId, setExternalId] = useState(newExternalId);
  const [result, setResult] = useState<InboundReplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const samples = useQuery({
    queryKey: ["samples", "inbound-picker"],
    queryFn: async () => (await api.listSamplesPage({ limit: 50 })).samples,
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setMode("manual");
    setText("");
    setSampleId("");
    setFile(null);
    setResult(null);
    setError(null);
    setExternalId(newExternalId());
  }, [open]);

  const submit = useMutation({
    mutationFn: async () => {
      let objectKey: string | undefined;
      if (mode === "screenshot") {
        if (!file) throw new Error("请选择一张聊天截图");
        const compressed = await compressImageFile(file);
        const presigned = await api.presignImage({
          mimeType: "image/jpeg",
          byteSize: compressed.blob.size,
          purpose: "inbound",
        });
        await uploadToPresignedUrl(presigned.uploadUrl, presigned.headers, compressed.blob);
        objectKey = presigned.objectKey;
      }
      return api.ingestInboundReply({
        channel: mode,
        externalId,
        customerId,
        ...(sampleId ? { sampleId } : {}),
        ...(mode === "manual" ? { text } : { objectKey }),
      });
    },
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      onDone();
      void queryClient.invalidateQueries({ queryKey: ["customers", customerId] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({ queryKey: ["panorama"] });
    },
    onError: (caught) => {
      setError(caught instanceof Error ? caught.message : "录入失败");
    },
  });

  if (!open) return null;

  const busy = submit.isPending;
  const canSubmit = mode === "manual" ? text.trim().length > 0 : file !== null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4 md:p-8">
      <div className="w-full max-w-2xl rounded-xl border border-line bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-ink-900">录入客户回复</h2>
            <p className="text-xs text-ink-400">
              {customerName} · 粘贴文本或上传截图，识别与草稿都在服务端完成
            </p>
          </div>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            关闭
          </Button>
        </header>

        <div className="grid gap-4 px-5 py-4">
          <div className="flex gap-1.5" role="group" aria-label="录入方式">
            {(
              [
                { value: "manual", label: "粘贴文本" },
                { value: "screenshot", label: "上传截图" },
              ] as const
            ).map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={mode === item.value}
                onClick={() => setMode(item.value)}
                className={cn(
                  "min-h-8 rounded-full border px-3 text-xs",
                  mode === item.value
                    ? "border-indigo-600 bg-indigo-100 text-indigo-600"
                    : "border-line text-ink-700 hover:border-ink-400",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          {mode === "manual" ? (
            <label className="grid gap-1 text-xs font-medium text-ink-700">
              客户原话
              <textarea
                className="input min-h-40 resize-y"
                value={text}
                maxLength={8000}
                onChange={(event) => setText(event.target.value)}
                placeholder="例如：这款 220g 棉手感不错，500 米什么价？下周能发货吗？"
              />
              <span className="text-xs font-normal text-ink-400">{text.length}/8000</span>
            </label>
          ) : (
            <label className="grid gap-1 text-xs font-medium text-ink-700">
              聊天截图（jpg / png / webp，上传前自动压缩）
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="text-sm"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              {file && <span className="text-xs font-normal text-ink-400">{file.name}</span>}
              <span className="text-xs font-normal text-ink-400">
                截图识别需要 openai-compatible 企业模型网关配置视觉模型（LLM_VISION_MODEL）；
                本地规则模式会明确报错，不会假装识别。
              </span>
            </label>
          )}

          <label className="grid gap-1 text-xs font-medium text-ink-700">
            关联面料（可选，选中后识别为询价会自动生成报价草稿）
            <select
              className="input"
              value={sampleId}
              onChange={(event) => setSampleId(event.target.value)}
            >
              <option value="">不关联，仅记录与识别</option>
              {(samples.data ?? []).map((sample) => (
                <option key={sample.id} value={sample.id}>
                  {sample.code} · {sample.name}
                </option>
              ))}
            </select>
          </label>

          {error && <p className="text-sm text-vermilion-600">{error}</p>}

          {result && (
            <div className="grid gap-2 rounded-lg border border-line bg-paper px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="success">已记入客户时间线</Badge>
                {result.classification && <Badge tone="info">{result.classification.intent}</Badge>}
                {isSimulated(result.classification?.provider) && (
                  <Badge tone="warning">模拟识别 · 非真实模型</Badge>
                )}
                {result.quoteDraftId && (
                  <Link
                    href={`/approvals?id=${encodeURIComponent(result.quoteDraftId)}&kind=quote`}
                    className="text-indigo-600 underline underline-offset-2"
                  >
                    查看报价草稿（待审批）
                  </Link>
                )}
              </div>
              {result.classification && (
                <p className="text-ink-700">{result.classification.summary}</p>
              )}
              {result.hint && <p className="text-ink-700">{result.hint}</p>}
              {result.draftError && <p className="text-vermilion-600">{result.draftError}</p>}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-line pt-3">
            <span className="text-xs text-ink-400">
              同一条消息重复提交，不会重复生成草稿。
            </span>
            <Button variant="primary" disabled={busy || !canSubmit} onClick={() => submit.mutate()}>
              {busy ? "正在识别…" : "录入并识别"}
            </Button>
          </div>
          {busy && <Spinner label="正在上传并识别客户回复…" />}
        </div>
      </div>
    </div>
  );
}
