import Link from "next/link";
import type { ClientErrorCode } from "@/src/api";
import { dict, nextLang } from "@/src/i18n";
import type { Lang } from "@/src/i18n";

/**
 * 链接失效 / 过期 / 撤回三种状态各有明确文案与下一步动作。
 * 这是 Server Component：错误页也保持零 JS 也能读，语言切换用链接实现。
 */
export function LinkErrorPage({
  code,
  token,
  lang,
}: {
  code: ClientErrorCode;
  token: string;
  lang: Lang;
}) {
  const t = dict(lang);
  const copy =
    code === "EXPIRED"
      ? { title: t.expiredTitle, body: t.expiredBody }
      : code === "REVOKED"
        ? { title: t.revokedTitle, body: t.revokedBody }
        : code === "UPSTREAM"
          ? { title: t.unavailableTitle, body: t.unavailableBody }
          : { title: t.invalidTitle, body: t.invalidBody };
  const other = nextLang(lang);

  return (
    <main className="shell">
      <div className="card error-state">
        <div className="error-icon" aria-hidden="true">
          !
        </div>
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        <div className="actions" style={{ maxWidth: 280, margin: "0 auto" }}>
          <p className="hint">{t.contactSales}</p>
          <Link className="button button-ghost" href={`/${token}?lang=${other}`} prefetch={false}>
            {t.language}
          </Link>
        </div>
      </div>
    </main>
  );
}
