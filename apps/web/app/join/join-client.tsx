"use client";

import { useEffect, useState } from "react";
import type { InvitePreview } from "@weave-order/schema";
import { memberRoleLabel } from "@weave-order/schema";
import { useApi } from "@/providers";
import { SupportMailto } from "@/support";
import { track } from "@/analytics";

/**
 * 接受同事邀请。
 *
 * 与开通链接同一套机制，差别是：这里不建公司，只把自己绑进已有公司。
 * 打开后先给「是哪家公司、什么角色、到哪天」，确认后才写入成员关系。
 */
export function JoinClient({ code }: { code: string }) {
  const api = useApi();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<{ tenantName: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!code) {
      setError("链接不完整：缺少邀请凭据。请从消息里重新打开一次。");
      setLoading(false);
      return;
    }
    api
      .previewInvite(code)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "邀请无效");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, code]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.acceptInvite(code);
      setJoined({ tenantName: result.tenantName });
      // 只记角色，不记被邀请人的邮箱。
      if (preview) track("invite_accepted", { role: preview.role });
      window.setTimeout(() => window.location.assign("/today"), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加入失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
        <p className="text-sm text-ink-400">正在核对邀请…</p>
      </main>
    );
  }

  if (joined) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
        <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink-900">已加入 {joined.tenantName}</h1>
        <p className="mt-2 text-sm text-ink-500">
          正在进入工作台。你能看到的客户范围由公司分配的角色决定。
        </p>
        <a
          href="/today"
          className="mt-6 inline-flex min-h-12 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
        >
          进入工作台
        </a>
      </main>
    );
  }

  if (error && !preview) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
        <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink-900">这条邀请用不了</h1>
        <p className="mt-2 text-sm text-ink-500">{error}</p>
        <p className="mt-4 text-xs leading-relaxed text-ink-400">
          可能是邀请超过 7 天、已被接受，或你的登录邮箱和被邀请的邮箱不一致。需要帮助就{" "}
          <SupportMailto
            className="text-indigo-600 underline underline-offset-4"
            label="写信给我们"
          />
          。
        </p>
        <div className="mt-6 flex gap-4 text-xs">
          <a href="/login" className="text-ink-400 underline underline-offset-4">
            换个账号登录
          </a>
          <a href="/start" className="text-ink-400 underline underline-offset-4">
            自己开一间公司
          </a>
        </div>
      </main>
    );
  }

  if (!preview) return null;

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
      <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink-900">
        {preview.alreadyMember ? `你已经在 ${preview.tenantName}` : `加入 ${preview.tenantName}`}
      </h1>
      <p className="mt-2 text-sm text-ink-500">
        {preview.alreadyMember
          ? "这个账号已经是公司成员，点一下直接进去。"
          : "接受后你会成为公司成员，看得到的客户范围由邀请时分配的角色决定。"}
      </p>

      <dl className="mt-6 grid gap-2 rounded-md border border-line bg-surface px-4 py-3 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-ink-400">公司</dt>
          <dd className="text-ink-900">{preview.tenantName}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-400">角色</dt>
          <dd className="text-ink-700">{memberRoleLabel(preview.role)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-400">被邀请邮箱</dt>
          <dd className="text-ink-700">{preview.email}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-400">链接有效期</dt>
          <dd className="text-ink-700">
            至 {new Date(preview.expiresAt).toLocaleDateString("zh-CN")}
          </dd>
        </div>
      </dl>

      {error ? (
        <p className="mt-4 rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void accept()}
        disabled={busy}
        className="mt-6 inline-flex min-h-12 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
      >
        {busy ? "正在加入…" : preview.alreadyMember ? "进入工作台" : "接受邀请"}
      </button>

      <p className="mt-4 text-xs leading-relaxed text-ink-400">
        邀请会核对邮箱：被邀请的是 {preview.email}，就要用这个邮箱的账号登录。链接 7 天有效。
      </p>
      <a href="/login" className="mt-4 text-xs text-ink-400 underline underline-offset-4">
        不是你的账号？换一个登录
      </a>
    </main>
  );
}
