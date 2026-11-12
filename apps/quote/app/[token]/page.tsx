import type { Metadata } from "next";
import { fetchQuotePage } from "@/src/server-api";
import type { Lang } from "@/src/i18n";
import { LinkErrorPage } from "./link-error";
import { QuoteClient } from "./quote-client";

/** 每次请求都重新渲染：浏览计数、有效期与接受状态都不能被 CDN 缓存。 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "报价单 · Quotation",
  robots: { index: false, follow: false },
};

function parseLang(value: string | string[] | undefined): Lang {
  return value === "en" ? "en" : "zh";
}

export default async function QuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ lang?: string | string[] }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const lang = parseLang(query.lang);

  // token 里只允许 base64url + "."，先做形状校验，避免把异常长串送进 API。
  if (!/^[A-Za-z0-9_-]{20,240}\.[A-Za-z0-9_-]{20,80}$/.test(token)) {
    return <LinkErrorPage code="INVALID_LINK" token={token} lang={lang} />;
  }

  const result = await fetchQuotePage(token);
  if (!result.ok) {
    return <LinkErrorPage code={result.error.code} token={token} lang={lang} />;
  }

  return <QuoteClient token={token} data={result.data} initialLang={lang} />;
}
