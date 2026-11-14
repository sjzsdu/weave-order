import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { StartClient } from "./start-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "创建公司空间 · 织序 WeaveOrder",
  description: "填公司名就能开始用，3 天全功能试用。",
  robots: { index: false, follow: false, nocache: true },
};

export default async function StartPage() {
  const store = await cookies();
  const token = store.get("weave_token")?.value;
  if (!token && process.env.NODE_ENV === "production") {
    redirect(`/auth/login?next=${encodeURIComponent("/start")}`);
  }
  return <StartClient />;
}
