"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ResourceReview } from "@/resource-review";

/** 客户草稿确认页（P0a）：字段出处 → 逐字段确认 → 确认可用。 */
export default function CustomerReviewPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  if (!id) return <p className="p-6 text-sm text-ink-400">缺少客户编号</p>;
  return (
    <div className="grid gap-4">
      <nav className="px-1 text-xs text-ink-400">
        <Link href="/panorama/customers" className="hover:text-ink-900">
          客户
        </Link>
        <span className="mx-1">/</span>
        <span className="text-ink-700">确认信息</span>
      </nav>
      <ResourceReview resourceType="customer" resourceId={id} />
    </div>
  );
}
