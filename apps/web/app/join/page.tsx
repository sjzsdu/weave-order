import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { JoinClient } from "./join-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "接受邀请 · 织序 WeaveOrder",
  description: "接受同事的邀请，加入公司空间。",
  robots: { index: false, follow: false, nocache: true },
};

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const store = await cookies();
  const token = store.get("weave_token")?.value;
  if (!token && process.env.NODE_ENV === "production") {
    const next = `/join?code=${encodeURIComponent(code ?? "")}`;
    redirect(`/auth/login?next=${encodeURIComponent(next)}`);
  }
  return <JoinClient code={code ?? ""} />;
}
