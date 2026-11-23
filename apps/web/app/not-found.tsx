import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-4 py-10">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-8 text-center">
        <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink-900">没有这个页面</h1>
        <p className="mt-2 text-sm text-ink-500">
          链接可能已失效，或地址写错了。已登录的话可以回到工作台继续。
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center rounded-md bg-ink-900 px-4 text-sm text-white hover:bg-ink-700"
          >
            回工作台首页
          </Link>
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
          >
            重新登录
          </Link>
        </div>
      </div>
    </main>
  );
}
