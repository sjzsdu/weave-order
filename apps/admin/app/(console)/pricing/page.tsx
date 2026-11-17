import Link from "next/link";
import type { Plan, PriceBook, PriceBookDetail } from "@weave-order/schema";
import { date, money, statusClass } from "@/src/format";
import { platformFetch } from "@/src/server-api";
import { ActivatePriceBook, PlanForm, PriceBookForm, PricingPreviewForm } from "@/src/actions";

export const dynamic = "force-dynamic";

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string }>;
}) {
  const params = await searchParams;
  const [{ plans }, { books }] = await Promise.all([
    platformFetch<{ plans: Plan[] }>("/pricing/plans"),
    platformFetch<{ books: PriceBook[] }>("/pricing/books"),
  ]);
  const details = await Promise.all(
    books.map((book) => platformFetch<PriceBookDetail>(`/pricing/books/${book.id}`)),
  );
  const active = details.find((detail) => detail.book.status === "ACTIVE") ?? details[0];
  const selected = params.book
    ? details.find((detail) => detail.book.id === params.book)
    : details.find((detail) => detail.book.status === "DRAFT");
  const impact = selected
    ? await platformFetch<{
        affectedTenants: number;
        monthlyDeltaCents: number;
        rows: {
          tenantName: string;
          planCode: string;
          seats: number;
          currentMonthlyCents: number;
          nextMonthlyCents: number;
          deltaCents: number;
        }[];
      }>(`/pricing/books/${selected.book.id}/impact`).catch(() => null)
    : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">商业化</div>
          <h1>套餐与价格</h1>
          <p>
            价格是配置不是代码：版本化价格表、租户覆盖、改价影响试算；生效需 owner + finance
            双人复核。
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>套餐</h2>
            <p>席位与内置额度；价格在下方价格表</p>
          </div>
        </div>
        {plans.length === 0 ? (
          <p className="alert alert-info" style={{ margin: 0 }}>
            尚未配置任何套餐。请用下方「新建套餐」创建第一个套餐，之后才能开通租户、维护价格表。
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>套餐</th>
                  <th className="num">席位</th>
                  <th className="num">agent 动作/月</th>
                  <th className="num">存储</th>
                  <th>功能</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.code}>
                    <td>
                      <strong>{plan.name}</strong>
                      <div className="tiny muted mono">{plan.code}</div>
                    </td>
                    <td className="num">
                      {plan.seatMin}–{plan.seatMax ?? "不限"}
                    </td>
                    <td className="num">{plan.agentActionsQuota.toLocaleString()}</td>
                    <td className="num">{plan.storageGb} GB</td>
                    <td className="tiny">
                      {Object.entries(plan.features)
                        .filter(([, enabled]) => enabled)
                        .map(([key]) => key)
                        .join("、") || "—"}
                    </td>
                    <td>
                      <span className={statusClass(plan.status)}>{plan.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <details className="card" open={plans.length === 0}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>新建套餐</summary>
        <p className="small muted">
          套餐定义席位与内置额度，价格在价格表版本里维护。套餐代码创建后不可修改。
        </p>
        <PlanForm existingCodes={plans.map((plan) => plan.code)} />
      </details>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>价格表版本</h2>
            <p>新版本只影响新合同；存量合同按签署时版本（grandfathering）。</p>
          </div>
        </div>
        {books.length === 0 ? (
          <p className="alert alert-info" style={{ margin: 0 }}>
            还没有任何价格表版本。在下方「新建价格版本」为每个套餐填写价格，保存为草稿后提交生效。
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>状态</th>
                  <th>生效日</th>
                  <th>说明</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {books.map((book) => (
                  <tr key={book.id}>
                    <td className="mono">v{book.version}</td>
                    <td>
                      <span className={statusClass(book.status)}>{book.status}</span>
                    </td>
                    <td className="tiny">{date(book.effectiveFrom)}</td>
                    <td className="tiny">{book.notes ?? "—"}</td>
                    <td className="tiny">
                      <Link className="btn btn-sm" href={`/pricing?book=${book.id}`}>
                        查看 / 试算
                      </Link>{" "}
                      {book.status === "DRAFT" ? <ActivatePriceBook bookId={book.id} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {active ? (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>当前生效价格 v{active.book.version}</h2>
              <p>每席位价格（整数分）</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>套餐</th>
                  <th className="num">月付</th>
                  <th className="num">年付（10 个月价）</th>
                </tr>
              </thead>
              <tbody>
                {active.prices.map((price) => (
                  <tr key={price.planCode}>
                    <td>{price.planCode}</td>
                    <td className="num">{money(price.monthlyPriceCents)}</td>
                    <td className="num">{money(price.annualPriceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {selected ? (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>影响试算：v{selected.book.version}</h2>
              <p>按当前订阅预览「他们下个月会付多少」，避免拍脑袋改价。</p>
            </div>
          </div>
          {impact ? (
            <>
              <div className="alert alert-info">
                受影响租户 {impact.affectedTenants} 家 · 月费合计变化{" "}
                <strong>{money(impact.monthlyDeltaCents)}</strong>
              </div>
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>租户</th>
                      <th>套餐</th>
                      <th className="num">席位</th>
                      <th className="num">当前月费</th>
                      <th className="num">新版本月费</th>
                      <th className="num">差额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {impact.rows.map((row) => (
                      <tr key={row.tenantName}>
                        <td>{row.tenantName}</td>
                        <td>{row.planCode}</td>
                        <td className="num">{row.seats}</td>
                        <td className="num">{money(row.currentMonthlyCents)}</td>
                        <td className="num">{money(row.nextMonthlyCents)}</td>
                        <td className="num">{money(row.deltaCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="small muted">该版本已生效或无法试算。</p>
          )}
        </div>
      ) : null}

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>新建价格版本</h2>
              <p>先落草稿；生效走双人复核</p>
            </div>
          </div>
          <PriceBookForm plans={plans} base={active} />
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>单租户试算</h2>
              <p>改价前先看一个具体报价</p>
            </div>
          </div>
          <PricingPreviewForm plans={plans} />
        </div>
      </div>
    </>
  );
}
