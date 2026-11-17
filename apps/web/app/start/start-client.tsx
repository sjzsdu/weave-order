"use client";

import { useState } from "react";
import { useApi } from "@/providers";
import { linkErrorCopy } from "@/link-errors";

/**
 * 自助创建公司。
 *
 * 登录后填公司名就能开始用，不再等平台发链接。一个账号一间公司：
 * 如果他其实已经有公司（重复点击、换设备再来一次），后端会返回既有的那间。
 */
export function StartClient() {
  const api = useApi();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ tenantName: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.startTenant({
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim().toLowerCase() } : {}),
      });
      if (result.alreadyActivated) {
        window.location.assign("/today");
        return;
      }
      setDone({ tenantName: result.tenantName });
      window.setTimeout(() => window.location.assign("/today"), 1200);
    } catch (cause) {
      console.warn("[start] 创建公司失败", cause);
      setError(linkErrorCopy(cause, "公司没建成，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
        <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink-900">{done.tenantName} 已开通</h1>
        <p className="mt-2 text-sm text-ink-500">
          你是这家公司的老板账号，正在进入工作台。建议先导入客户和样品，然后派第一件活。
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

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
      <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink-900">创建你的公司空间</h1>
      <p className="mt-2 text-sm text-ink-500">
        填个公司名就能开始用。3 天试用，不绑卡；公司数据只属于你，别人看不到。
      </p>

      <form onSubmit={(event) => void submit(event)} className="mt-6 grid gap-4">
        <label className="grid gap-1 text-xs text-ink-400">
          公司名称
          <input
            required
            minLength={2}
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：青禾纺织"
            className="rounded-md border border-line-strong bg-paper px-3 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-indigo-600 focus:outline-none"
          />
        </label>
        <label className="grid gap-1 text-xs text-ink-400">
          公司标识（选填，用于单据与技术支持）
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="qinghe"
            pattern="[a-z0-9-]{2,64}"
            className="rounded-md border border-line-strong bg-paper px-3 py-2.5 font-mono text-sm text-ink-900 placeholder:text-ink-400 focus:border-indigo-600 focus:outline-none"
          />
        </label>

        {error ? (
          <p className="rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy || name.trim().length < 2}
          className="inline-flex min-h-12 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {busy ? "正在创建…" : "创建公司并进入"}
        </button>
      </form>

      <p className="mt-5 text-xs leading-relaxed text-ink-400">
        已经有同事邀请你？别在这里建公司——打开他发给你的邀请链接，登录后点「接受邀请」就会加入他们。
      </p>
    </main>
  );
}
