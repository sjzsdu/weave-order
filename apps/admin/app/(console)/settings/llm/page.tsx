import type { Metadata } from "next";
import type { PlatformLlmSettings, TenantSummary } from "@weave-order/schema";
import { money } from "@/src/format";
import { platformFetch } from "@/src/server-api";
import { LlmOverrideForm, LlmSettingsForm, LlmTestButton } from "@/src/actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "设置 · LLM 设置" };

interface LlmStats {
  period: string;
  totalCostCents: number;
  rows: {
    tenantId: string;
    tenantName: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  }[];
}

export default async function LlmSettingsPage() {
  const [{ global, overrides }, stats, { tenants }] = await Promise.all([
    platformFetch<{ global: PlatformLlmSettings; overrides: PlatformLlmSettings[] }>(
      "/settings/llm",
    ),
    platformFetch<LlmStats>("/settings/llm/stats"),
    platformFetch<{ tenants: TenantSummary[] }>("/tenants"),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">平台</div>
          <h1>LLM 设置</h1>
          <p>
            全局参数 + 租户覆盖；key 只存引用（环境变量 / KMS），不落明文。token
            只计量成本，不收费。
          </p>
        </div>
        <LlmTestButton baseUrl={global.baseUrl ?? undefined} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>全局参数</h2>
              <p>
                v{global.version} · {global.updatedBy ?? "未设置"}
              </p>
            </div>
          </div>
          <LlmSettingsForm settings={global} />
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>租户覆盖</h2>
              <p>默认继承全局；单独端点/预算按租户覆盖</p>
            </div>
          </div>
          <LlmOverrideForm tenants={tenants} settings={overrides} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>调用统计（{stats.period}）</h2>
            <p>合计成本 {money(stats.totalCostCents)}</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>租户</th>
                <th className="num">输入 token</th>
                <th className="num">输出 token</th>
                <th className="num">成本</th>
              </tr>
            </thead>
            <tbody>
              {stats.rows.map((row) => (
                <tr key={row.tenantId}>
                  <td>{row.tenantName}</td>
                  <td className="num">{row.inputTokens.toLocaleString()}</td>
                  <td className="num">{row.outputTokens.toLocaleString()}</td>
                  <td className="num">{money(row.costCents)}</td>
                </tr>
              ))}
              {stats.rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    本月还没有 LLM 调用。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
