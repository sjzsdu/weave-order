import type { Metadata } from "next";
import { fetchSampleCard } from "@/src/sample-api";

/**
 * 样卡扫码页（`/s/sample/<token>`）。
 *
 * 页面只说两件事：这是哪个样品、找谁。没有客户、价格、成本、报价单号；
 * 不写 Cookie、不埋点、不加载第三方资源，因此线下扫码也不会把客户信息留在手机上。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "样卡 · Sample Card",
  robots: { index: false, follow: false },
};

export default async function SampleCardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // 样卡 token 是紧凑 base64url（含长度前缀 + 12 字节 HMAC），没有 "." 分隔符。
  const valid = /^[A-Za-z0-9_-]{40,120}$/.test(token);
  const result = valid
    ? await fetchSampleCard(token)
    : { ok: false as const, message: "链接无效，请扫描样卡上的二维码" };

  if (!result.ok) {
    return (
      <main className="shell">
        <div className="card error-state">
          <div className="error-icon" aria-hidden="true">
            !
          </div>
          <h1>样卡链接无效</h1>
          <p>{result.message}</p>
          <p className="hint">If the code still does not work, please contact your salesperson.</p>
        </div>
      </main>
    );
  }

  const { sampleCode, sample, salesperson } = result.data;
  return (
    <main className="shell">
      <div className="card" style={{ maxWidth: 420, margin: "0 auto", padding: "28px 24px" }}>
        <p
          style={{
            fontSize: 12,
            letterSpacing: 2,
            color: "var(--muted, #6b7280)",
            textTransform: "uppercase",
          }}
        >
          样品详情 / Sample
        </p>
        {sample.imageUrl ? (
          // 签名 URL 域名不固定，不用 next/image 的域名白名单。
          <img
            src={sample.imageUrl}
            alt={sample.name}
            style={{
              width: "100%",
              maxHeight: 260,
              objectFit: "cover",
              borderRadius: 12,
              marginTop: 12,
              border: "1px solid var(--line, #e5e7eb)",
            }}
          />
        ) : null}
        <h1
          style={{
            margin: "18px 0 4px",
            fontSize: 30,
            lineHeight: 1.2,
            wordBreak: "break-word",
          }}
        >
          {sample.name}
        </h1>
        <p
          style={{
            margin: "0 0 6px",
            fontSize: 16,
            fontVariantNumeric: "tabular-nums",
            color: "var(--ink, #111827)",
          }}
        >
          样品编号 {sampleCode}
        </p>
        <p style={{ margin: "4px 0 20px", fontSize: 12, color: "var(--muted, #6b7280)" }}>
          本页显示样品属性与业务员联系方式，不含价格、客户与成本信息。
        </p>

        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "6px 16px",
            margin: "0 0 20px",
            fontSize: 14,
          }}
        >
          <dt style={{ color: "var(--muted, #6b7280)" }}>成分</dt>
          <dd style={{ margin: 0 }}>{sample.composition || "—"}</dd>
          <dt style={{ color: "var(--muted, #6b7280)" }}>颜色</dt>
          <dd style={{ margin: 0 }}>{sample.color || "—"}</dd>
          <dt style={{ color: "var(--muted, #6b7280)" }}>克重</dt>
          <dd style={{ margin: 0 }}>{sample.weight || "—"}</dd>
          <dt style={{ color: "var(--muted, #6b7280)" }}>品类</dt>
          <dd style={{ margin: 0 }}>{sample.category || "—"}</dd>
        </dl>

        <div
          style={{
            borderTop: "1px solid var(--line, #e5e7eb)",
            paddingTop: 16,
            display: "grid",
            gap: 6,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--muted, #6b7280)" }}>联系业务员</span>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{salesperson.name || "您的业务员"}</span>
          {salesperson.phone ? (
            <a
              href={`tel:${salesperson.phone.replace(/[^\d+]/g, "")}`}
              className="button"
              style={{ marginTop: 8, display: "inline-block", textAlign: "center" }}
            >
              致电 {salesperson.phone}
            </a>
          ) : (
            <span className="hint">请通过您常用的联系方式联系业务员。</span>
          )}
        </div>
      </div>
    </main>
  );
}
