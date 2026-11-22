import { redirect } from "next/navigation";
import TodayPage from "@/today-page";
import { resolveWorkspaceIAServer } from "@/workspace-ia.server";

export const dynamic = "force-dynamic";

/**
 * 旧入口 `/today`（WAN-196）。
 *
 * 新 IA 下它只是书签别名：307 到 `/items?filter=recent`，历史书签不会 404。
 * 例外是演示剧本深链（`?scene=`）与输入深链（`?intent=` 带原话，`?compose=1`
 * 只打开空白输入框）：前者锚定旧审批卡，后者是统一输入页（WAN-194）上线前
 * 的唯一输入入口，空状态引导会落到这里。
 * 租户关闭新 IA（`workspaceIA=legacy`）时，整页照旧渲染，旧功能不回归。
 */
export default async function TodayRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const ia = await resolveWorkspaceIAServer();
  if (ia === "new" && !params.scene && !params.intent && !params.compose) {
    redirect("/items?filter=recent");
  }
  return <TodayPage />;
}
