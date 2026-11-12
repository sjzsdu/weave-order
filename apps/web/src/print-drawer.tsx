"use client";

import { useEffect } from "react";
import { Badge, Button } from "@weave-order/ui";

const TABS = ["队列", "模板", "设备"] as const;

/**
 * 打印中心是全局抽屉，不是第四个窗口（IA 铁律）。
 * P1 才接打印代理；现在只保留入口、队列结构与空态。
 */
export function PrintDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div aria-hidden={!open} className={open ? "" : "pointer-events-none"}>
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-label="关闭打印中心"
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-ink-900/20 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="打印中心"
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col border-l border-line bg-surface shadow-xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">打印中心</h2>
            <p className="mt-0.5 text-xs text-ink-400">全局抽屉 · 不打断当前工作</p>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="关闭">
            ✕
          </Button>
        </header>
        <div className="flex gap-1 border-b border-line px-5 pt-3">
          {TABS.map((tab, index) => (
            <span
              key={tab}
              className={`rounded-t-md px-3 py-2 text-sm ${
                index === 0 ? "border-b-2 border-indigo-600 text-indigo-600" : "text-ink-400"
              }`}
            >
              {tab}
              {index === 2 && <Badge tone="neutral" className="ml-1">0</Badge>}
            </span>
          ))}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <p className="text-sm font-medium text-ink-900">队列里还没有打印任务</p>
          <p className="text-sm text-ink-400">
            打印代理接通后，发货单、箱唛、样品标签会在这里排队。
          </p>
          <Badge tone="info">P1 实现</Badge>
        </div>
        <footer className="border-t border-line px-5 py-3 text-xs text-ink-400">
          打印是全局抽屉：只有队列 / 模板 / 设备三页，不新增一级导航。
        </footer>
      </aside>
    </div>
  );
}
