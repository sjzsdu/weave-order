import Link from "next/link";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink-900">登录租户工作台</h1>
      <p className="mt-2 text-sm text-ink-400">
        身份由 Casdoor 负责（一个租户一个 Organization）；本地只保留角色与数据范围映射。
      </p>

      {error && (
        <p className="mt-4 rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
          登录失败：{error}
        </p>
      )}

      <div className="mt-6 grid gap-3">
        <a
          href={`/auth/login?next=${encodeURIComponent(next ?? "/today")}`}
          className="inline-flex min-h-12 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
        >
          使用 Casdoor 登录
        </a>
        {process.env.NODE_ENV !== "production" && (
          <>
            <a
              href={`/auth/dev?next=${encodeURIComponent(next ?? "/today")}`}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface px-4 text-sm text-ink-700 hover:border-ink-400"
            >
              本地 dev 身份（dev:demo:demo）
            </a>
            <Link
              href="/today?demo=1"
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-dashed border-line px-4 text-sm text-ink-400 hover:border-ink-400"
            >
              无后端预览（演示数据）
            </Link>
          </>
        )}
      </div>
      <p className="mt-6 text-xs text-ink-400">
        回调地址固定为 <code className="font-mono">/auth/callback</code>；前端不存密码，也不传 tenant_id。
      </p>
    </main>
  );
}
