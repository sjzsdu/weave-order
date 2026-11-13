import type { Metadata } from "next";
import Link from "next/link";
import { fetchQuotePage } from "@/src/server-api";
import type { Lang } from "@/src/i18n";
import { LinkErrorPage } from "../link-error";
import { PrintClient } from "./print-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "报价单打印 · Quotation",
  robots: { index: false, follow: false },
};

export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ lang?: string | string[] }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const lang: Lang = query.lang === "en" ? "en" : "zh";

  const result = await fetchQuotePage(token, { track: false });
  if (!result.ok) {
    return <LinkErrorPage code={result.error.code} token={token} lang={lang} />;
  }

  return (
    <>
      <PrintClient token={token} data={result.data} lang={lang} />
      <main className="shell no-print" style={{ paddingTop: 0 }}>
        <Link className="button button-ghost" href={`/${token}?lang=${lang}`} prefetch={false}>
          ← {lang === "en" ? "Back to quote" : "返回报价"}
        </Link>
      </main>
    </>
  );
}
