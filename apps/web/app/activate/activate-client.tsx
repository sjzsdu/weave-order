"use client";

import { useEffect, useState } from "react";
import type { OnboardingPreview, OnboardingResult } from "@weave-order/schema";
import { useApi } from "@/providers";
import { SupportMailto } from "@/support";
import { track } from "@/analytics";
import { TrackedLink } from "@/tracked-link";

const MARKETING_URL = process.env.NEXT_PUBLIC_MARKETING_URL ?? "https://weaveorder.cn";

/**
 * 开通链接落地页。
 *
 * 三种状态：查看（这是哪家公司）→ 领取（建公司 + 成为老板）→ 进入工作台。
 * 领取是幂等的：老板手滑刷新两次，第二次直接告诉他「已经在里面了」。
 */
export function ActivateClient({ code }: { code: string }) {
  const api = useApi();
  const [preview, setPreview] = useState<OnboardingPreview | null>(null);
  const [result, setResult] = useState<OnboardingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!code) {
      setError("链接不完整：缺少开通凭据。请从我们发你的消息里重新打开一次。");
      setLoading(false);
      return;
    }
    api
      .previewOnboarding(code)
      .then((data) => {
        if (!cancelled) {
          setPreview(data);
          // 漏斗第一步：开通链接真的被打开了（不是打开就关掉）。
          track("activate_link_opened");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "链接无效");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, code]);

  async function claim() {
    setClaiming(true);
    setError(null);
    try {
      const done = await api.claimOnboarding(code);
      setResult(done);
      track("activate_completed");
      window.setTimeout(() => window.location.assign("/today"), 900);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "开通失败，请重试");
    } finally {
      setClaiming(false);
    }
  }

  if (loading) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
        <p className="text-sm text-ink-400">正在核对开通链接…</p>
      </main>
    );
  }

  if (result) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
        <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink-900">{result.tenantName} 已开通</h1>
        <p className="mt-2 text-sm text-ink-500">
          你现在是这家公司的老板账号，正在进入工作台。第一次进来建议先导入客户和样品。
        </p>
        <a
          href="/today"
          className="mt-6 inline-flex min-h-12 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
        >
          进入工作台
        </a>
        <a
          href={`${MARKETING_URL}/docs/quickstart.html`}
          className="mt-3 text-xs text-ink-400 underline underline-offset-4"
        >
          先看 5 分钟上手
        </a>
      </main>
    );
  }

  if (error || !preview) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
        <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink-900">这个开通链接用不了</h1>
        <p className="mt-2 text-sm text-ink-500">{error ?? "链接已失效，请向对接人重新索取。"}</p>
        <div className="mt-6 grid gap-2 text-xs text-ink-500">
          <p>可能的原因：链接超过 7 天、已被撤回，或登录邮箱与登记邮箱不一致。</p>
          <p>
            需要帮助就{" "}
            <SupportMailto
              className="text-indigo-600 underline underline-offset-4"
              label="写信给我们"
            />
            ，把这条消息截图发过来。
          </p>
        </div>
        <TrackedLink
          href="/login"
          event="login_click"
          eventProps={{ from: "activate-page" }}
          className="mt-6 text-xs text-ink-400 underline underline-offset-4"
        >
          换个账号登录
        </TrackedLink>
      </main>
    );
  }

  const expires = new Date(preview.expiresAt).toLocaleDateString("zh-CN");

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
      <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink-900">
        {preview.membershipExists ? `进入 ${preview.name}` : `开通 ${preview.name} 的工作空间`}
      </h1>
      <p className="mt-2 text-sm text-ink-500">
        {preview.membershipExists
          ? "这个账号已经是公司成员，点一下直接进去。"
          : "点一下就会建好公司空间，你会成为这家公司的老板账号。3 天试用内不想用，可以随时导出数据走人。"}
      </p>

      <dl className="mt-6 grid gap-2 rounded-md border border-line bg-surface px-4 py-3 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-ink-400">公司</dt>
          <dd className="text-ink-900">{preview.name}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-400">公司标识</dt>
          <dd className="font-mono text-xs text-ink-700">{preview.slug}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-400">链接有效期</dt>
          <dd className="text-ink-700">至 {expires}</dd>
        </div>
        {preview.ownerEmail ? (
          <div className="flex justify-between gap-4">
            <dt className="text-ink-400">登记邮箱</dt>
            <dd className="text-ink-700">{preview.ownerEmail}</dd>
          </div>
        ) : null}
      </dl>

      {error ? (
        <p className="mt-4 rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void claim()}
        disabled={claiming}
        className="mt-6 inline-flex min-h-12 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
      >
        {claiming ? "正在开通…" : preview.membershipExists ? "进入工作台" : "开通并进入"}
      </button>

      <p className="mt-4 text-xs leading-relaxed text-ink-400">
        开通用的是你当前登录的账号；公司数据只属于这间公司，其他公司看不到。登录邮箱与登记邮箱不一致时会被拦下。
      </p>
      <TrackedLink
        href="/login"
        event="login_click"
        eventProps={{ from: "activate-page" }}
        className="mt-4 text-xs text-ink-400 underline underline-offset-4"
      >
        不是你的账号？换一个登录
      </TrackedLink>
    </main>
  );
}
