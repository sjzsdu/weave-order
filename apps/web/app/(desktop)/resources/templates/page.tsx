"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { PrintTemplate } from "@weave-order/schema";
import { Badge, EmptyState, Spinner } from "@weave-order/ui";
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

/**
 * 模板资源（WAN-196）：只读列表，编辑器属于 P0c，不在这里提前做。
 * 写入口仍走打印中心 / 设置，页面不提供第二个发布入口。
 */
export default function TemplateResourcesPage() {
  const mounted = useMounted();
  if (!mounted) return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  return <TemplateResourcesContent />;
}

function TemplateResourcesContent() {
  const api = useApi();
  const templates = useQuery({
    queryKey: ["print", "templates"],
    queryFn: () => api.printTemplates(),
  });

  const templateLabel = (template: PrintTemplate) =>
    `${template.name}${template.variant ? ` · ${template.variant}` : ""}`;

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
          系统模板随版本内置；公司覆盖发布后出现在这里。自定义编辑器在 P0c，当前不支持在页面内编辑。
        </p>
      </header>

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
                <th className="px-3 py-2 text-left font-normal">来源</th>
                <th className="px-3 py-2 text-left font-normal">版本</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {templates.data.templates.map((template) => (
                <tr key={template.id}>
                  <td className="px-3 py-2 text-ink-900">{templateLabel(template)}</td>
                  <td className="px-3 py-2 text-ink-700">
                    {KIND_LABEL[template.kind] ?? template.kind}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={template.isSystem ? "neutral" : "info"}>
                      {SCOPE_LABEL[template.scope] ?? template.scope}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-ink-700">
                    {template.activeVersion?.version ?? "—"} / {template.versionCount}
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
