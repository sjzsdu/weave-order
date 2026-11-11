import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AuditLogEntry,
  Customer,
  FabricSample,
  QuoteDraft,
  T004GenerateQuoteDraftResult,
} from "@weave-order/schema";

/** 金额（分）-> 展示字符串。只做展示，权威值始终来自后端。 */
function formatCents(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${currency} ${yuan}.${(abs % 100).toString().padStart(2, "0")}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export default function App() {
  const [samples, setSamples] = useState<FabricSample[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<QuoteDraft | null>(null);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAudit = useCallback(async () => {
    const data = await api<{ entries: AuditLogEntry[] }>("/api/audit?limit=8");
    setAudit(data.entries);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [sampleData, customerData] = await Promise.all([
          api<{ samples: FabricSample[] }>("/api/samples?limit=20"),
          api<{ customers: Customer[] }>("/api/customers?limit=20"),
        ]);
        if (cancelled) return;
        setSamples(sampleData.samples);
        setCustomers(customerData.customers);
        setSelectedId(sampleData.samples[0]?.id ?? null);
        await refreshAudit();
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "加载失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshAudit]);

  const customer = customers[0] ?? null;
  const sample = useMemo(
    () => samples.find((item) => item.id === selectedId) ?? samples[0] ?? null,
    [samples, selectedId],
  );

  const generateDraft = async () => {
    if (!customer || !sample) return;
    setBusy(true);
    setError(null);
    try {
      const currency = sample.costFloor?.currency ?? "CNY";
      const unitPriceAmount = (sample.costFloor?.amount ?? 1200) + 300;
      const result = await api<T004GenerateQuoteDraftResult>("/api/tools/generate-quote-draft", {
        method: "POST",
        body: JSON.stringify({
          customerId: customer.id,
          currency,
          validityDays: 30,
          remarks: "页面演示：智能体生成的报价草稿",
          items: [
            {
              fabricSampleId: sample.id,
              quantity: { value: 120.5, unit: sample.unit },
              unitPrice: { amount: unitPriceAmount, currency },
            },
          ],
        }),
      });
      if (!result.ok) {
        setError(
          result.error.code === "INVALID_INPUT"
            ? `输入校验失败：${result.error.issues.map((issue) => issue.message).join("；")}`
            : `${result.error.code}：${result.error.message}`,
        );
        return;
      }
      setDraft(result.data.draft);
      await refreshAudit();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成失败");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <main className="shell">
        <p className="hint">正在连接内核…</p>
      </main>
    );
  }

  const seeded = samples.length > 0 && customer !== null;

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">织序 WeaveOrder · 找样与报价</p>
          <h1>让智能体出草稿，人类只做确认</h1>
          <p className="lede">
            这一页只读：选一个样品，点一次按钮，看智能体通过工具生成报价草稿。
            金额由确定性内核计算，草稿状态是 DRAFT，人类确认后才生效。
          </p>
        </div>
        <div className="law">
          <span>agent → tools → kernel</span>
          <span>金额整数「分」</span>
          <span>每次写入都有审计</span>
        </div>
      </header>

      {!seeded && (
        <section className="empty">
          <h2>还没有数据</h2>
          <p>
            先在仓库根目录执行 <code>pnpm demo</code>（会自动跑迁移并写入演示客户与样品），
            然后刷新本页。
          </p>
        </section>
      )}

      {seeded && (
        <div className="layout">
          <section className="panel">
            <div className="panel-head">
              <h2>样品库</h2>
              <span className="muted">{samples.length} 个样品</span>
            </div>
            <ul className="samples">
              {samples.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`sample ${item.id === sample?.id ? "selected" : ""}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="sample-name">{item.name}</span>
                    <span className="sample-meta">
                      {item.code} · {item.composition ?? "成分未登记"} ·{" "}
                      {item.weight ?? "克重未登记"}
                    </span>
                    <span className="sample-meta">
                      成本底线{" "}
                      {item.costFloor
                        ? formatCents(item.costFloor.amount, item.costFloor.currency)
                        : "未设置"}{" "}
                      / {item.unit === "meter" ? "米" : item.unit}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel action">
            <div className="panel-head">
              <h2>智能体操作</h2>
              {customer && <span className="muted">客户：{customer.name}</span>}
            </div>
            <p className="muted">
              选中样品后，智能体将调用 T-004 生成报价草稿；它拿不到数据库，也不能确认。
            </p>
            <button
              type="button"
              className="primary"
              onClick={() => {
                void generateDraft();
              }}
              disabled={busy || !sample}
            >
              {busy ? "智能体正在生成…" : "让智能体生成报价草稿"}
            </button>
            {error && <p className="error">{error}</p>}

            {draft ? (
              <article className="draft">
                <header>
                  <span className="badge">DRAFT</span>
                  <strong>{formatCents(draft.total.amount, draft.total.currency)}</strong>
                </header>
                <p className="muted">
                  金额由内核计算（{draft.amountsComputedByKernel ? "是" : "否"}），有效期{" "}
                  {draft.validityDays} 天
                </p>
                <ul className="lines">
                  {draft.items.map((line) => (
                    <li key={line.fabricSampleId}>
                      <span>{line.description}</span>
                      <span>
                        {line.quantity.value} {line.quantity.unit} ×{" "}
                        {formatCents(line.unitPrice.amount, line.unitPrice.currency)} ={" "}
                        {formatCents(line.lineTotal.amount, line.lineTotal.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="muted small">
                  草稿不会自动生效：需要人类在审批窗口确认（页面上没有这个按钮，是有意的）。
                </p>
              </article>
            ) : (
              <p className="hint">点上面那个按钮，草稿会出现在这里。</p>
            )}
          </section>
        </div>
      )}

      <section className="panel audit">
        <div className="panel-head">
          <h2>审计流水</h2>
          <span className="muted">最近 {audit.length} 条 · 只追加，不可改写</span>
        </div>
        <ul>
          {audit.map((entry) => (
            <li key={entry.id}>
              <span className="seq">#{entry.seq}</span>
              <span className="action">{entry.action}</span>
              <span className="muted">
                {entry.actorType}:{entry.actorId} · {entry.entityType}
              </span>
              <time>{new Date(entry.createdAt).toLocaleTimeString("zh-CN")}</time>
            </li>
          ))}
          {audit.length === 0 && <li className="hint">暂无审计记录</li>}
        </ul>
      </section>
    </main>
  );
}
