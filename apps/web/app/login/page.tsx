import Link from "next/link";
import { safeNext } from "@/public-origin";
import { SupportMailto } from "@/support";
import { TrackedLink } from "@/tracked-link";
import { isProductionLike } from "@/runtime-mode";

// MARKETING_URL 是部署时注入的运行时变量，优先读它。
// NEXT_PUBLIC_* 会在构建期被内联，只靠它的话改 .env 换官网域名不会生效。
const MARKETING_URL = (
  process.env.MARKETING_URL ??
  process.env.NEXT_PUBLIC_MARKETING_URL ??
  "https://weaveorder.cn"
).replace(/\/$/, "");

// 统一登录地址与 OIDC issuer 是同一个，部署时只配一处。
const SSO_URL = process.env.CASDOOR_ISSUER ?? "https://sso.wnbgj.com";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  // 官网静态页路径 / 外站地址不进 OIDC 回跳，统一落到工作台首页。
  const target = safeNext(next);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">织序 WeaveOrder</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink-900">登录工作台</h1>
      <p className="mt-2 text-sm text-ink-500">用公司的统一账号登录，不用再记一个密码。</p>

      {error && (
        <p className="mt-4 rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
          登录没有成功：{error}。可以重试一次，或者联系公司管理员确认账号是否已开通。
        </p>
      )}

      <div className="mt-6 grid gap-3">
        <TrackedLink
          href={`/auth/login?next=${encodeURIComponent(target)}`}
          event="login_click"
          eventProps={{ from: "login-page" }}
          className="inline-flex min-h-12 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
        >
          使用公司账号登录
        </TrackedLink>
        <div className="flex items-center justify-between text-xs text-ink-400">
          <a
            href={SSO_URL}
            className="underline underline-offset-4 hover:text-indigo-600"
            rel="noopener"
          >
            忘记密码
          </a>
          <a
            href="/auth/login?mode=signup&next=%2Fstart"
            className="underline underline-offset-4 hover:text-indigo-600"
          >
            还没有账号？注册并创建公司
          </a>
        </div>
      </div>

      <details className="mt-8 rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink-500">
        <summary className="cursor-pointer font-medium text-ink-700">登录遇到问题</summary>
        <ul className="mt-3 grid gap-2 text-xs leading-relaxed">
          <li>
            <b className="text-ink-700">提示账号不存在或未开通</b>：让公司管理员在「组织与设置 →
            成员」里邀请你，或{" "}
            <SupportMailto
              className="text-indigo-600 underline underline-offset-4"
              label="写信给我们"
            />
            。
          </li>
          <li>
            <b className="text-ink-700">登录成功但看不到数据</b>
            ：角色和数据范围还没配。销售默认只看自己的客户， 找管理员调整即可，不需要重新登录。
          </li>
          <li>
            <b className="text-ink-700">页面一直转圈</b>：换用 Chrome / Edge / Safari 近两年版本，
            或检查公司网络是否拦截了登录跳转。
          </li>
        </ul>
        <p className="mt-3 text-xs">
          更多说明见{" "}
          <a
            href={`${MARKETING_URL}/docs/faq.html`}
            className="text-indigo-600 underline underline-offset-4"
          >
            帮助中心的登录与账号
          </a>
          。
        </p>
      </details>

      {!isProductionLike() && (
        <div className="mt-6 grid gap-2 rounded-md border border-dashed border-line px-4 py-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-ink-400">仅本地开发</p>
          <a
            href={`/auth/dev?next=${encodeURIComponent(target)}`}
            className="text-xs text-ink-500 underline underline-offset-4 hover:text-indigo-600"
          >
            使用本地开发身份（dev:demo:demo）
          </a>
          <Link
            href="/today?demo=1"
            className="text-xs text-ink-500 underline underline-offset-4 hover:text-indigo-600"
          >
            不进后端，直接看演示数据
          </Link>
        </div>
      )}

      <p className="mt-8 text-xs leading-relaxed text-ink-400">
        客户查看报价不需要登录：报价链接打开即可看。登录只给内部同事使用，我们不保存你的密码。
      </p>
      <p className="mt-2 text-xs text-ink-400">
        <a href={MARKETING_URL} className="underline underline-offset-4 hover:text-indigo-600">
          返回官网
        </a>
      </p>
    </main>
  );
}
