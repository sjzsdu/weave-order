import { redirect } from "next/navigation";
import { PanoramaOverview } from "@/panorama-overview";
import { resolveWorkspaceIAServer } from "@/workspace-ia.server";

export const dynamic = "force-dynamic";

/**
 * 旧入口 `/panorama`（WAN-196）。
 *
 * 新 IA 下「业务全景」改名「资源」并对齐到 `/resources`；307 而不是 308，
 * 因为灰度开关关闭时这个路径还要回到旧页面，不能被浏览器永久缓存。
 * `/panorama/customers` 等深链不受影响，继续原样工作。
 */
export default async function PanoramaRoute() {
  const ia = await resolveWorkspaceIAServer();
  if (ia === "new") redirect("/resources");
  return <PanoramaOverview />;
}
