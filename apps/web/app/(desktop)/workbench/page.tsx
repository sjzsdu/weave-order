import TodayPage from "@/today-page";

export const dynamic = "force-dynamic";

/**
 * 工作台（WAN-204 第二轮）：智能体动态 + 待决事项 + 最近动态。
 *
 * 新 IA 把 `/today` 留作书签别名（307 到事项），但「今天小织在干什么」仍是核心视图。
 * 单独给一个稳定入口，避免用户只能从「新建事项」的深链看到它。
 */
export default function WorkbenchRoute() {
  return <TodayPage />;
}
