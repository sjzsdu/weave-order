"use client";

import { AuditLogView } from "@/audit-log";
import { useMounted } from "@/use-mounted";

export default function LogsPage() {
  const mounted = useMounted();
  if (!mounted) {
    return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  }
  return <AuditLogView />;
}
