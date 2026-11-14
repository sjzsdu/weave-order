import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ActivateClient } from "./activate-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "开通织序 · 建立你的公司空间",
  description: "打开开通链接，用统一账号登录，建立公司空间。",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * 开通链接入口。
 *
 * 未登录时先去登录，登录后回到本页（next 参数由 /auth/callback 使用）。
 * 本地开发没有 Cookie 时仍可渲染：BFF 会用 DEV_AUTH_TOKEN 兜底。
 */
export default async function ActivatePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const store = await cookies();
  const token = store.get("weave_token")?.value;
  if (!token && process.env.NODE_ENV === "production") {
    const next = `/activate?code=${encodeURIComponent(code ?? "")}`;
    redirect(`/auth/login?next=${encodeURIComponent(next)}`);
  }
  return <ActivateClient code={code ?? ""} />;
}
