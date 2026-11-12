import * as Tabs from "@radix-ui/react-tabs";
import { useEffect } from "react";
import { useAppStore } from "./store";
import type { WindowKey } from "./store";
import { BTN_GHOST } from "./ui";
import { IntentBar } from "./windows/IntentBar";
import { Panorama } from "./windows/Panorama";
import { ReviewQueue } from "./windows/ReviewQueue";

const TABS: { key: WindowKey; label: string; hint: string }[] = [
  { key: "intent", label: "① 任务派发", hint: "Intent Bar" },
  { key: "review", label: "② 审批与异常分诊", hint: "Review Queue" },
  { key: "panorama", label: "③ 业务全景（只读）", hint: "Read-Only Panorama" },
];

const TRIGGER =
  "rounded-t-lg border-b-2 border-transparent px-4 py-3 text-sm font-medium text-muted outline-none transition-colors hover:text-text focus-visible:ring-1 focus-visible:ring-accent data-[state=active]:border-accent data-[state=active]:text-accent";

const LAWS = ["agent → tools → kernel", "智能体只出草稿", "人类审批后 confirm 生效", "全景只读"];

/** 三个窗口的外壳：Radix Tabs 切换，Zustand 持有共享只读数据与决策动作。 */
export default function App() {
  const activeWindow = useAppStore((s) => s.activeWindow);
  const setActiveWindow = useAppStore((s) => s.setActiveWindow);
  const refresh = useAppStore((s) => s.refresh);
  const loading = useAppStore((s) => s.loading);
  const globalError = useAppStore((s) => s.globalError);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main className="mx-auto max-w-[1180px] px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-line pb-6">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-accent">
            织序 WeaveOrder · 三个窗口 MVP
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-text">让智能体出草稿，人类只做确认</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            智能体是默认操作者：派发意图、产出草稿 / 建议；人类只在审批窗口批准或拒绝。
            批准后前端才调内核 confirm 生效，全景窗口只读。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {LAWS.map((law) => (
            <span
              key={law}
              className="rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted"
            >
              {law}
            </span>
          ))}
        </div>
      </header>

      {loading && <p className="mt-4 text-sm text-muted">正在连接内核…</p>}
      {globalError && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/50 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span>
            连接内核失败：{globalError}。请先执行{" "}
            <code>docker compose up -d &amp;&amp; pnpm demo</code> 再刷新。
          </span>
          <button type="button" className={BTN_GHOST} onClick={() => void refresh()}>
            重试
          </button>
        </div>
      )}

      <Tabs.Root
        value={activeWindow}
        onValueChange={(value) => setActiveWindow(value as WindowKey)}
        className="mt-6"
      >
        <Tabs.List className="flex flex-wrap gap-1 border-b border-line" aria-label="三个窗口">
          {TABS.map((tab) => (
            <Tabs.Trigger key={tab.key} value={tab.key} className={TRIGGER}>
              {tab.label}{" "}
              <span className="ml-1 text-[11px] font-normal text-muted">{tab.hint}</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <div className="mt-6">
          <Tabs.Content value="intent" className="outline-none">
            <IntentBar />
          </Tabs.Content>
          <Tabs.Content value="review" className="outline-none">
            <ReviewQueue />
          </Tabs.Content>
          <Tabs.Content value="panorama" className="outline-none">
            <Panorama />
          </Tabs.Content>
        </div>
      </Tabs.Root>

      <footer className="mt-10 border-t border-line pt-4 text-xs text-muted">
        架构铁律：只这三个窗口 · 基础资料（客户 / 样品）内联录入，业务单据只由智能体产出草稿 ·
        前端不绕过 tools 直连内核或写账本。
      </footer>
    </main>
  );
}
