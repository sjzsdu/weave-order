"use client";

import Link from "next/link";
import { useState } from "react";
import type { QuoteLinkErrorCode } from "@weave-order/schema";
import { acceptQuote, askQuestion, type QuotePageData } from "@/src/api";
import { dict, nextLang } from "@/src/i18n";
import type { Lang } from "@/src/i18n";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatQuantity,
  lineLabel,
  validityRatio,
} from "@/src/lib";

const WATERMARK_COUNT = 18;

function localError(code: QuoteLinkErrorCode, lang: Lang): string {
  const zh = lang !== "en";
  switch (code) {
    case "PHONE_TAIL_REQUIRED":
      return zh ? "请填写手机尾号后 4 位。" : "Please enter the last 4 digits.";
    case "PHONE_TAIL_MISMATCH":
      return zh ? "手机尾号不匹配，请核对后重试。" : "Those digits do not match. Please try again.";
    case "EXPIRED":
      return zh ? "这条报价已过期。" : "This quotation has expired.";
    case "REVOKED":
      return zh ? "这条链接已被撤回。" : "This link has been withdrawn.";
    case "PDF_DISABLED":
      return zh ? "该报价未开放 PDF 下载。" : "PDF download is disabled for this quotation.";
    default:
      return zh ? "操作失败，请稍后重试。" : "Something went wrong. Please try again.";
  }
}

export function QuoteClient({
  token,
  data,
  initialLang,
}: {
  token: string;
  data: QuotePageData;
  initialLang: Lang;
}) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [acceptedAt, setAcceptedAt] = useState<string | null>(data.acceptedAt);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [phoneTail, setPhoneTail] = useState("");
  const [acceptBusy, setAcceptBusy] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [lineIndex, setLineIndex] = useState<string>("all");
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [askDone, setAskDone] = useState(false);

  const t = dict(lang);
  const view = data.view;
  const lowValidity = data.remainingDays <= 3;

  const watermark = `${view.customerName} · ${view.quoteNumber}`;

  async function submitAccept(event: React.FormEvent) {
    event.preventDefault();
    setAcceptError(null);
    if (data.requirePhoneTail && !/^\d{4}$/.test(phoneTail)) {
      setAcceptError(localError("PHONE_TAIL_REQUIRED", lang));
      return;
    }
    setAcceptBusy(true);
    const result = await acceptQuote(token, data.requirePhoneTail ? phoneTail : undefined);
    setAcceptBusy(false);
    if (result.ok) {
      setAcceptedAt(result.data.acceptedAt);
      setAcceptOpen(false);
      return;
    }
    setAcceptError(localError(result.error.code, lang));
  }

  async function submitQuestion(event: React.FormEvent) {
    event.preventDefault();
    setAskError(null);
    setAskDone(false);
    if (message.trim().length === 0) {
      setAskError(lang === "en" ? "Please write a message." : "请先写下你的问题。");
      return;
    }
    setAskBusy(true);
    const result = await askQuestion(
      token,
      message.trim(),
      lineIndex === "all" ? null : Number(lineIndex),
    );
    setAskBusy(false);
    if (result.ok) {
      setMessage("");
      setAskDone(true);
      return;
    }
    setAskError(localError(result.error.code, lang));
  }

  function toggleLang() {
    const next = nextLang(lang);
    setLang(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("lang", next);
      window.history.replaceState(null, "", url);
      document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    }
  }

  return (
    <main className="shell">
      <div className="watermark" aria-hidden="true">
        {Array.from({ length: WATERMARK_COUNT }, (_, index) => (
          <span key={index}>{watermark}</span>
        ))}
      </div>

      <header className="topbar">
        <div>
          <p className="brand-eyebrow">{t.brand}</p>
          <h1 className="brand-name">{view.tenantName}</h1>
          <p className="brand-sub">
            {t.quoteNo} {view.quoteNumber}
          </p>
        </div>
        <button type="button" className="lang-button no-print" onClick={toggleLang}>
          {t.language}
        </button>
      </header>

      <section className="card">
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

        <div className="validity">
          <span className="validity-label">{t.validUntil}</span>
          <span className={`validity-badge${lowValidity ? " low" : ""}`}>
            {t.remaining(data.remainingDays)}
          </span>
        </div>
        <div className="validity-track" aria-hidden="true">
          <div
            className="validity-fill"
            style={{ width: `${validityRatio(data.remainingDays) * 100}%` }}
          />
        </div>

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

        <div className="actions no-print">
          {acceptedAt ? (
            <div className="accepted" role="status">
              <strong>{t.accepted}</strong>
              <p>{t.acceptedAt(formatDateTime(acceptedAt, lang))}</p>
              <p>{t.acceptNote}</p>
            </div>
          ) : acceptOpen ? (
            <form className="accept-panel" onSubmit={(event) => void submitAccept(event)}>
              <h3>{t.acceptTitle}</h3>
              {data.requirePhoneTail && (
                <div className="field">
                  <label htmlFor="phone-tail">{t.phoneTail}</label>
                  <input
                    id="phone-tail"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={4}
                    pattern="\d{4}"
                    value={phoneTail}
                    onChange={(event) => setPhoneTail(event.target.value.replace(/\D/g, ""))}
                  />
                  <span className="hint">{t.phoneTailHint}</span>
                </div>
              )}
              {acceptError && (
                <p className="form-error" role="alert">
                  {acceptError}
                </p>
              )}
              <p>{t.acceptNote}</p>
              <button type="submit" className="button button-primary" disabled={acceptBusy}>
                {acceptBusy ? t.accepting : t.confirmAccept}
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setAcceptOpen(false)}
                disabled={acceptBusy}
              >
                {t.cancel}
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                className="button button-primary"
                onClick={() => setAcceptOpen(true)}
              >
                {t.accept}
              </button>
              <p className="offer-note">{t.acceptNote}</p>
            </>
          )}

          {askOpen ? (
            <form className="accept-panel" onSubmit={(event) => void submitQuestion(event)}>
              <h3>{t.askTitle}</h3>
              <p>{t.askHint}</p>
              <div className="field">
                <label htmlFor="ask-line">{t.askLine}</label>
                <select
                  id="ask-line"
                  value={lineIndex}
                  onChange={(event) => setLineIndex(event.target.value)}
                >
                  <option value="all">{t.askAll}</option>
                  {view.lines.map((line, index) => (
                    <option value={index} key={`${line.description}-option-${index}`}>
                      {lineLabel(index, lang)} · {line.description}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ask-message">{t.askTitle}</label>
                <textarea
                  id="ask-message"
                  value={message}
                  maxLength={1000}
                  placeholder={t.askPlaceholder}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </div>
              {askError && (
                <p className="form-error" role="alert">
                  {askError}
                </p>
              )}
              {askDone && (
                <p className="success" role="status">
                  {t.askDone}
                </p>
              )}
              <button type="submit" className="button button-primary" disabled={askBusy}>
                {askBusy ? t.asking : t.askSubmit}
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setAskOpen(false)}
                disabled={askBusy}
              >
                {t.cancel}
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setAskOpen(true)}
            >
              {t.askTitle}
            </button>
          )}

          {view.allowPdf ? (
            <Link
              className="button button-secondary"
              href={`/${token}/print?lang=${lang}`}
              target="_blank"
              rel="noreferrer"
            >
              {t.downloadPdf}
            </Link>
          ) : (
            <p className="hint">{t.pdfDisabled}</p>
          )}
        </div>

        <footer className="footer">
          <span>{t.offerNote}</span>
          <span>{watermark}</span>
        </footer>
      </section>
    </main>
  );
}
