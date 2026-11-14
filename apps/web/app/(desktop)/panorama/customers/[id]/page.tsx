"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMounted } from "@/use-mounted";
import { Customer360Panel } from "@/customer-360";

/** 客户 360 独立页：抽屉之外的可收藏 / 可分享地址。 */
export default function CustomerDetailPage() {
  const mounted = useMounted();
  const params = useParams<{ id: string }>();
  if (!mounted) {
    return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  }
  const id = params?.id;
  if (!id) {
    return (
      <div className="p-6 text-sm text-ink-400">
        客户不存在。
        <Link href="/panorama/customers" className="ml-2 text-indigo-600 underline">
          回客户列表
        </Link>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <Link
        href="/panorama/customers"
        className="text-xs text-ink-400 underline underline-offset-2"
      >
        ← 回客户列表
      </Link>
      <Customer360Panel customerId={id} embedded />
    </div>
  );
}
