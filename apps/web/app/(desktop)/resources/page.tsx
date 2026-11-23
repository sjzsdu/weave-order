import { ResourceOverview } from "@/resource-overview";

export const dynamic = "force-dynamic";

/** 资源首页：只展示全量统计与资料结构，明细仍由客户、样品和模板页承担。 */
export default function ResourcesPage() {
  return <ResourceOverview />;
}
