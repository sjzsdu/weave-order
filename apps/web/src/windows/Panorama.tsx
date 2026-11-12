import { customerName, formatCents, statusBadgeClass, timeLabel } from "../lib";
import { useAppStore } from "../store";
import { BADGE_BASE, BTN_GHOST, CARD } from "../ui";

function StatCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-[#11161c] px-4 py-3">
      <p className="wo-kicker">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone ?? "text-text"}`}>{value}</p>
    </div>
  );
}

const EXCEPTION_STATUSES = ["REJECTED", "CANCELLED", "EXPIRED"];

/**
 * 窗口三 · Read-Only Panorama（业务全景只读视图）。
 *
 * 全部数据来自 GET /api/panorama 的只读聚合，本窗口不提供任何写操作 / 确认按钮。
 * 账本状态（DRAFT → SENT/CONFIRMED/REJECTED/CANCELLED）在这里只做展示。
 */
export function Panorama() {
  const panorama = useAppStore((s) => s.panorama);
  const customers = useAppStore((s) => s.customers);
  const refresh = useAppStore((s) => s.refresh);

  if (!panorama) {
    return (
      <div className={CARD}>
        <p className="text-sm text-muted">
          全景数据尚未加载。请确认 API 已启动并执行 <code>pnpm demo</code>（迁移 +
          演示数据），然后点刷新。
        </p>
        <button type="button" className={`${BTN_GHOST} mt-4`} onClick={() => void refresh()}>
          刷新
        </button>
      </div>
    );
  }

  const { stats } = panorama;
  const exceptions = panorama.items.filter((item) => EXCEPTION_STATUSES.includes(item.status));

  return (
    <section className="grid gap-5">
      <div className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-text">业务全景</h2>
              <span className={`${BADGE_BASE} border-accent/60 bg-accent/10 text-accent`}>
                只读 · 无写操作
              </span>
            </div>
            <p className="mt-1 text-sm text-muted">
              一次只读聚合：账本状态、客户、样品、审计流水。快照时间{" "}
              {timeLabel(panorama.generatedAt)}。
            </p>
          </div>
          <button type="button" className={BTN_GHOST} onClick={() => void refresh()}>
            刷新
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="客户" value={stats.customerCount} />
          <StatCard label="样品" value={stats.sampleCount} />
          <StatCard label="报价单" value={stats.quoteCount} />
          <StatCard label="寄样单" value={stats.shipmentCount} />
          <StatCard label="待审批 DRAFT" value={stats.pendingCount} tone="text-warn" />
          <StatCard label="已生效报价" value={stats.sentQuoteCount} tone="text-accent" />
          <StatCard label="已确认寄样" value={stats.confirmedShipmentCount} tone="text-accent" />
          <StatCard label="驳回 / 异常" value={stats.rejectedCount} tone="text-danger" />
        </div>
      </div>

      <div className={CARD}>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-base font-semibold text-text">全部单据（只读）</h3>
          <span className="wo-kicker">{panorama.items.length} 条</span>
        </div>
        {panorama.items.length === 0 ? (
          <p className="mt-3 text-sm text-muted">账本里还没有单据。到「任务派发」窗口产出草稿。</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {panorama.items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-[#11161c] px-3 py-2 text-sm"
              >
                <span className="text-text">{item.title}</span>
                <span className="text-xs text-muted">
                  {customerName(customers, item.customerId)} · {item.summary}
                </span>
                <span className={`${BADGE_BASE} ${statusBadgeClass(item.status)}`}>
                  {item.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {exceptions.length > 0 && (
        <div className={`${CARD} border-danger/40`}>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-base font-semibold text-danger">异常 / 驳回分诊（只读）</h3>
            <span className="wo-kicker">{exceptions.length} 条</span>
          </div>
          <ul className="mt-3 grid gap-2">
            {exceptions.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-[#11161c] px-3 py-2 text-sm"
              >
                <span className="text-text">{item.title}</span>
                <span className="text-xs text-muted">{item.summary}</span>
                <span className={`${BADGE_BASE} ${statusBadgeClass(item.status)}`}>
                  {item.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <div className={CARD}>
          <h3 className="text-base font-semibold text-text">客户</h3>
          <ul className="mt-3 grid gap-2">
            {panorama.customers.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-line bg-[#11161c] px-3 py-2 text-sm"
              >
                <span className="text-text">{item.name}</span>
                <span className="text-xs text-muted">
                  {item.code} · {item.tier}
                </span>
              </li>
            ))}
            {panorama.customers.length === 0 && <li className="text-sm text-muted">暂无客户</li>}
          </ul>
        </div>

        <div className={CARD}>
          <h3 className="text-base font-semibold text-text">样品目录</h3>
          <ul className="mt-3 grid gap-2">
            {panorama.samples.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-[#11161c] px-3 py-2 text-sm"
              >
                <span className="text-text">
                  {item.code} · {item.name}
                </span>
                <span className="text-xs text-muted">
                  {item.composition ?? "成分未登记"} ·{" "}
                  {item.costFloor
                    ? `${formatCents(item.costFloor.amount, item.costFloor.currency)} 底线`
                    : "无底线"}
                </span>
              </li>
            ))}
            {panorama.samples.length === 0 && <li className="text-sm text-muted">暂无样品</li>}
          </ul>
        </div>
      </div>

      <div className={CARD}>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-base font-semibold text-text">审计流水（只追加，不可改写）</h3>
          <span className="wo-kicker">最近 {panorama.audit.length} 条</span>
        </div>
        <ul className="mt-3 grid gap-1">
          {panorama.audit.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-3 border-t border-line py-2 text-xs"
            >
              <span className="font-mono text-muted">#{entry.seq}</span>
              <span className="font-mono text-accent">{entry.action}</span>
              <span className="text-muted">
                {entry.actorType}:{entry.actorId} · {entry.entityType}
              </span>
              <time className="ml-auto text-muted">{timeLabel(entry.createdAt)}</time>
            </li>
          ))}
          {panorama.audit.length === 0 && <li className="text-sm text-muted">暂无审计记录</li>}
        </ul>
      </div>
    </section>
  );
}
