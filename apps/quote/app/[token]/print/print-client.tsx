"use client";

import { useEffect, useRef } from "react";
import { recordPdfDownload, type QuotePageData } from "@/src/api";
import { dict } from "@/src/i18n";
import type { Lang } from "@/src/i18n";
import { formatDate, formatMoney, formatQuantity } from "@/src/lib";

const WATERMARK_COUNT = 12;

/**
 * 打印 / 另存为 PDF。进入页面即记录一次 PDF_DOWNLOADED（同一挂载只记一次），
 * 并自动唤起浏览器打印对话框；水印与页面完全一致。
 */
export function PrintClient({
  token,
  data,
  lang,
}: {
  token: string;
  data: QuotePageData;
  lang: Lang;
}) {
  const recorded = useRef(false);
  const t = dict(lang);
  const view = data.view;
  const watermark = `${view.customerName} · ${view.quoteNumber}`;

  useEffect(() => {
    if (recorded.current) return;
    recorded.current = true;
    void recordPdfDownload(token).then(() => {
      window.setTimeout(() => window.print(), 350);
    });
  }, [token]);

  return (
    <main className="shell">
      <div className="watermark" aria-hidden="true">
        {Array.from({ length: WATERMARK_COUNT }, (_, index) => (
          <span key={index}>{watermark}</span>
        ))}
      </div>

      <div
        className="no-print"
        style={{ display: "flex", justifyContent: "space-between", gap: 12 }}
      >
        <p className="hint">{t.printHint}</p>
        <button type="button" className="button button-secondary" onClick={() => window.print()}>
          {t.printButton}
        </button>
      </div>

      <section className="card" style={{ marginTop: 12 }}>
        <header className="topbar">
          <div>
            <p className="brand-eyebrow">{t.brand}</p>
            <h1 className="brand-name">{view.tenantName}</h1>
            <p className="brand-sub">
              {t.quoteNo} {view.quoteNumber}
            </p>
          </div>
        </header>

        <dl className="meta">
          <div>
            <dt>{t.quoteFor}</dt>
            <dd>{view.customerName}</dd>
          </div>
          <div>
            <dt>{t.validUntil}</dt>
            <dd>{formatDate(view.expiresAt, lang)}</dd>
          </div>
          <div className="span-2">
            <dt>{t.issuedBy}</dt>
            <dd>{view.tenantName}</dd>
          </div>
        </dl>

        <div className="lines">
          {view.lines.map((line, index) => (
            <div className="line" key={`${line.description}-${index}`}>
              <span className="line-name">{line.description}</span>
              <span className="line-amount">
                {formatMoney(line.lineTotalAmount, view.currency, lang)}
              </span>
              <span className="line-meta">
                {formatQuantity(line.quantity, line.unit, lang)} ·{" "}
                {formatMoney(line.unitPriceAmount, view.currency, lang)}
              </span>
            </div>
          ))}
        </div>

        <div className="totals">
          <div className="total-row">
            <span>{t.subtotal}</span>
            <span className="money">{formatMoney(view.subtotalAmount, view.currency, lang)}</span>
          </div>
          <div className="total-row grand">
            <span>{t.total}</span>
            <span className="money">{formatMoney(view.totalAmount, view.currency, lang)}</span>
          </div>
        </div>

        <div className="terms">
          <h3>{t.termsTitle}</h3>
          {data.terms ?? t.termsFallback}
        </div>

        {data.salesContact && (
          <div className="sales-card">
            <div>
              <p className="sales-kicker">{t.contactSales}</p>
              <p className="sales-name">{data.salesContact.name}</p>
              {data.salesContact.phoneMasked && (
                <p className="sales-phone">{data.salesContact.phoneMasked}</p>
              )}
            </div>
            {data.salesContact.wechatQrUrl && (
              <img
                className="sales-qr"
                src={data.salesContact.wechatQrUrl}
                alt={t.wechatQr}
                width={88}
                height={88}
                onError={(event) => { event.currentTarget.style.display = "none"; }}
              />
            )}
          </div>
        )}

        <footer className="footer">
          <span>{t.offerNote}</span>
          <span>{watermark}</span>
        </footer>
      </section>
    </main>
  );
}
