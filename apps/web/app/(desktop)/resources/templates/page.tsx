"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrintTemplate } from "@weave-order/schema";
import { Badge, Button, EmptyState, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMounted } from "@/use-mounted";

const KIND_LABEL: Record<PrintTemplate["kind"], string> = {
  PICKING_LIST: "拣货单",
  DELIVERY_NOTE: "发货单",
  PACKING_LIST: "装箱单",
  BOX_LABEL: "箱唛",
  SAMPLE_LABEL: "实体样卡",
  SHELF_LABEL: "货架标签",
  TEST_LABEL: "测试标签",
};

const SCOPE_LABEL: Record<PrintTemplate["scope"], string> = {
  SYSTEM: "系统内置",
  COMPANY: "公司发布",
  DOCUMENT_TYPE: "单据类型覆盖",
};

const FORMAT_LABEL: Record<PrintTemplate["format"], string> = {
  HTML: "A4",
  ZPL: "80×50（ZPL）",
  TSPL: "80×50（TSPL）",
};

/** 系统样卡模板 key 与格式一一对应；复制时按 key 取默认版式。 */
const SAMPLE_SOURCE: Record<PrintTemplate["format"], string> = {
  HTML: "system/sample-card/classic-a4",
  ZPL: "system/sample-card/zpl-80x50",
  TSPL: "system/sample-card/tspl-80x50",
};

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "操作失败，请稍后重试";
}

/**
 * 模板资源（WAN-196 建立，P0c 接入编辑器）。
 *
 * 系统模板只读；业务员复制一份自成草稿，编辑、发布版本、试打都在这里进入。
 * 目前可视化编辑只覆盖实体样卡（P0c 范围），其它单据继续走文本模板发布。
 */
export default function TemplateResourcesPage() {
  const mounted = useMounted();
  if (!mounted) return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  return <TemplateResourcesContent />;
}

function TemplateResourcesContent() {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState("我的样卡版式");
  const [format, setFormat] = useState<PrintTemplate["format"]>("HTML");
  const [feedback, setFeedback] = useState<string | null>(null);

  const templates = useQuery({
    queryKey: ["print", "templates"],
    queryFn: () => api.printTemplates(),
  });

  const copy = useMutation({
    mutationFn: () =>
      api.copyPrintTemplate({
        sourceTemplateId: SAMPLE_SOURCE[format],
        kind: "SAMPLE_LABEL",
        format,
        name: name.trim(),
      }),
    onSuccess: (detail) => {
      void queryClient.invalidateQueries({ queryKey: ["print", "templates"] });
      router.push(`/resources/templates/${detail.template.id}`);
    },
    onError: (error) => setFeedback(errorText(error)),
  });

  const templateLabel = (template: PrintTemplate) =>
    `${template.name}${template.variant ? ` · ${template.variant}` : ""}`;
  const editable = (template: PrintTemplate) =>
    !template.isSystem && template.kind === "SAMPLE_LABEL";

  return (
    <div className="grid gap-4 pb-6">
      <header>
        <nav className="flex items-center gap-1 text-xs text-ink-400">
          <Link href="/resources" className="hover:text-ink-900">
            资源
          </Link>
          <span>/</span>
          <span className="text-ink-700">模板</span>
        </nav>
        <h1 className="mt-1 text-2xl font-semibold text-ink-900">模板</h1>
        <p className="mt-1 text-sm text-ink-400">
          系统模板随版本内置。样卡可以复制一份为草稿，改版式、选字段、发版本、试打；
          已发布的版本不会被改写，只会新增。
        </p>
      </header>

      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-medium text-ink-700">复制系统样卡开始编辑</h2>
        <p className="mt-1 text-xs text-ink-400">复制出来的是草稿：发布前正式打印仍用系统样卡。</p>
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) {
              setFeedback("先给模板起个名字");
              return;
            }
            setFeedback(null);
            copy.mutate();
          }}
        >
          <label className="grid gap-1 text-xs text-ink-400">
            模板名称
            <input
              className="min-h-10 w-56 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={128}
            />
          </label>
          <label className="grid gap-1 text-xs text-ink-400">
            版面
            <select
              className="min-h-10 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
              value={format}
              onChange={(event) => setFormat(event.target.value as PrintTemplate["format"])}
            >
              <option value="HTML">A4 样卡（HTML / PDF）</option>
              <option value="ZPL">80×50mm 标签（ZPL）</option>
              <option value="TSPL">80×50mm 标签（TSPL）</option>
            </select>
          </label>
          <Button type="submit" variant="primary" disabled={copy.isPending}>
            {copy.isPending ? "正在复制…" : "复制并编辑"}
          </Button>
        </form>
        {feedback ? (
          <p className="mt-2 text-sm text-vermilion-600" role="alert">
            {feedback}
          </p>
        ) : null}
      </section>

      {templates.isLoading ? <Spinner label="正在读取模板…" /> : null}
      {templates.isError ? (
        <EmptyState
          title="模板暂时不可用"
          description={templates.error instanceof Error ? templates.error.message : "请稍后重试"}
        />
      ) : null}
      {templates.data && templates.data.templates.length === 0 ? (
        <EmptyState
          title="还没有模板"
          description="系统模板会随版本内置，公司覆盖发布后出现在这里。"
        />
      ) : null}

      {templates.data && templates.data.templates.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-normal">模板</th>
                <th className="px-3 py-2 text-left font-normal">用途</th>
                <th className="px-3 py-2 text-left font-normal">版面</th>
                <th className="px-3 py-2 text-left font-normal">来源</th>
                <th className="px-3 py-2 text-left font-normal">版本</th>
                <th className="px-3 py-2 text-left font-normal">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {templates.data.templates.map((template) => (
                <tr key={template.id}>
                  <td className="px-3 py-2 text-ink-900">{templateLabel(template)}</td>
                  <td className="px-3 py-2 text-ink-700">
                    {KIND_LABEL[template.kind] ?? template.kind}
                  </td>
                  <td className="px-3 py-2 text-ink-700">
                    {template.activeVersion?.pageSize
                      ? `${template.activeVersion.pageSize}（${template.format}）`
                      : FORMAT_LABEL[template.format]}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={template.isSystem ? "neutral" : "info"}>
                      {SCOPE_LABEL[template.scope] ?? template.scope}
                    </Badge>
                    {template.hasDraft ? (
                      <Badge tone="warning" className="ml-1">
                        草稿
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-ink-700">
                    {template.activeVersion?.version ?? "—"} / {template.versionCount}
                  </td>
                  <td className="px-3 py-2">
                    {editable(template) ? (
                      <Link
                        href={`/resources/templates/${template.id}`}
                        className="text-sm text-indigo-600 underline"
                      >
                        {template.hasDraft ? "继续编辑" : "编辑版式"}
                      </Link>
                    ) : template.isSystem && template.kind === "SAMPLE_LABEL" ? (
                      <span className="text-xs text-ink-400">在上方复制后编辑</span>
                    ) : (
                      <span className="text-xs text-ink-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
