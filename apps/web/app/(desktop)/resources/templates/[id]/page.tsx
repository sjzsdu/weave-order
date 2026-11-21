"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMounted } from "@/use-mounted";
import { PrintTemplateEditor } from "@/print-template-editor";

/**
 * 样卡模板编辑（P0c）。路由只负责取 id；编辑逻辑在 `PrintTemplateEditor`。
 */
export default function TemplateEditorPage() {
  const params = useParams<{ id: string }>();
  const mounted = useMounted();
  const templateId = params?.id;

  if (!mounted) return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  if (!templateId) {
    return (
      <div className="p-6 text-sm text-ink-400">
        模板不存在。<Link href="/resources/templates" className="underline">回到模板列表</Link>
      </div>
    );
  }
  return (
    <div className="p-4 md:p-6">
      <PrintTemplateEditor templateId={templateId} />
    </div>
  );
}
