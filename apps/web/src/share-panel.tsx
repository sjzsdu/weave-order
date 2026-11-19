"use client";

import { useEffect, useState } from "react";
import type { CreatedQuoteShare, CustomerContact, QuoteShareStats } from "@weave-order/schema";
import { pickDefaultContact } from "@weave-order/schema";
import { Badge, Button, EmptyState, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";

/**
 * 报价链接面板（业务员侧）。
 *
 * 明文 token 只在生成响应出现一次；列表里不回显旧链接（库里只有 hash），
 * 只展示访问次数 / 独立访客 / 是否接受 / 客户留言，并可撤回。
 */
export function SharePanel({
  quoteId,
  title,
  initialCreated,
  contacts,
  onClose,
}: {
  quoteId: string;
  title: string;
  initialCreated?: CreatedQuoteShare;
  /** 客户 360 打开时带上联系人，用于默认收件人（报价 → 采购）与切换。 */
  contacts?: CustomerContact[];
  onClose: () => void;
}) {
  const api = useApi();
  const [shares, setShares] = useState<QuoteShareStats[] | null>(null);
  const [created, setCreated] = useState<CreatedQuoteShare | null>(initialCreated ?? null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 报价外发默认找「采购」，找不到回退主联系人；用户可在这里切换。
  const defaultContact = contacts ? pickDefaultContact(contacts, "quote") : null;
  const [contactId, setContactId] = useState<string>(defaultContact?.id ?? "");

  const load = async () => {
    setError(null);
    try {
      setShares(await api.quoteShareStats(quoteId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取访问数据失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.quoteShareStats(quoteId);
        if (!cancelled) {
          setShares(data);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "读取访问数据失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, quoteId]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const share = await api.createQuoteShare({
        quoteId,
        requirePhoneTail: true,
        allowPdf: true,
        ...(contactId ? { contactId } : {}),
      });
      setCreated(share);
      setCopied(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生成链接失败");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (shareId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.revokeQuoteShare(shareId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "撤回失败");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      setError("复制失败，请手动选中链接复制。");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/50 p-4 py-10"
      role="dialog"
      aria-modal="true"
      aria-label="报价链接与访问数据"
    >
      <div className="w-full max-w-2xl rounded-lg border border-line bg-surface p-5 shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">
              客户报价链接 · 无登录
            </p>
            <h2 className="mt-1 text-lg font-semibold text-ink-900">{title}</h2>
            <p className="mt-1 text-sm text-ink-400">
              有效期跟随报价；手机尾号验证；接受只产生成交意向，不改报价账本。
            </p>
          </div>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-vermilion-600/30 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
            {error}
          </p>
        )}

        {created && (
          <div className="mt-4 rounded-lg border border-moss-600/40 bg-moss-600/10 p-4">
            <p className="text-sm font-medium text-moss-600">链接已生成（明文只显示这一次）</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                readOnly
                value={created.url}
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs text-ink-700"
              />
              <Button variant="primary" onClick={() => void copy()}>
                {copied ? "已复制" : "复制"}
              </Button>
              <a
                className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:bg-paper"
                href={created.url}
                target="_blank"
                rel="noreferrer"
              >
                预览
              </a>
            </div>
            <p className="mt-2 text-xs text-ink-400">
              请立即通过微信/邮件发给客户；关闭后无法再取回这条链接，只能重新生成。
            </p>
          </div>
        )}

        {contacts && contacts.length > 0 && (
          <label className="mt-4 flex flex-wrap items-center gap-2 text-xs text-ink-400">
            发给
            <select
              value={contactId}
              onChange={(event) => setContactId(event.target.value)}
              className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
            >
              <option value="">不指定（自动选采购 / 主联系人）</option>
              {contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                  {contact.role ? ` · ${contact.role}` : ""}
                  {contact.isPrimary ? " · 主要" : ""}
                </option>
              ))}
            </select>
            <span>记录到这条分享上，之后改名或归档仍显示发送时的快照。</span>
          </label>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-ink-400">访问数据 · {shares?.length ?? 0} 条链接</span>
          <Button variant="primary" onClick={() => void create()} disabled={busy}>
            {busy ? "处理中…" : "生成新链接"}
          </Button>
        </div>

        {loading ? (
          <div className="mt-4">
            <Spinner label="正在读取访问数据…" />
          </div>
        ) : !shares || shares.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="还没有生成过链接"
              description="批准报价后点「生成新链接」，即可发到客户微信。"
            />
          </div>
        ) : (
          <ul className="mt-3 grid gap-3">
            {shares.map((share) => {
              const expired = new Date(share.expiresAt).getTime() <= Date.now();
              const status = share.revokedAt
                ? { label: "已撤回", tone: "danger" as const }
                : expired
                  ? { label: "已过期", tone: "warning" as const }
                  : share.acceptedAt
                    ? { label: "客户已接受", tone: "success" as const }
                    : { label: "等待查看", tone: "info" as const };
              return (
                <li
                  key={share.shareId}
                  className="rounded-lg border border-line bg-paper px-3 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs text-ink-400">
                      v{share.version} · {share.shareId.slice(0, 8)}
                    </span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-ink-400 sm:grid-cols-4">
                    <span>
                      访问 <strong className="text-ink-900">{share.viewCount}</strong> 次
                    </span>
                    <span>
                      独立访客 <strong className="text-ink-900">{share.uniqueVisitors}</strong>
                    </span>
                    <span>
                      PDF <strong className="text-ink-900">{share.pdfDownloadCount}</strong>
                    </span>
                    <span>
                      留言 <strong className="text-ink-900">{share.questionCount}</strong>
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-4 text-xs text-ink-400">
                    <span>到期 {new Date(share.expiresAt).toLocaleDateString("zh-CN")}</span>
                    {share.lastViewedAt && (
                      <span>最近查看 {new Date(share.lastViewedAt).toLocaleString("zh-CN")}</span>
                    )}
                    {share.acceptedAt && (
                      <span className="text-moss-600">
                        接受于 {new Date(share.acceptedAt).toLocaleString("zh-CN")}
                      </span>
                    )}
                  </div>
                  {share.questions.length > 0 && (
                    <ul className="mt-2 grid gap-1 border-t border-line pt-2">
                      {share.questions.map((question) => (
                        <li key={question.eventId} className="text-xs text-ink-400">
                          <span className="text-indigo-600">
                            {question.lineIndex === null
                              ? "整单"
                              : `第 ${question.lineIndex + 1} 行`}
                          </span>
                          ：{question.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {!share.revokedAt && !expired && (
                    <div className="mt-2 flex justify-end">
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => void revoke(share.shareId)}
                      >
                        撤回
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <p className={cn("mt-4 text-xs text-ink-400")}>
          隐私最小化：不写追踪 Cookie；IP/UA 只存加盐哈希；客户无需填资料即可查看。
        </p>
      </div>
    </div>
  );
}
