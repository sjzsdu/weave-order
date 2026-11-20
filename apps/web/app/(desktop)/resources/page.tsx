import { PanoramaOverview } from "@/panorama-overview";

export const dynamic = "force-dynamic";

/**
 * 资源首页（WAN-196）：客户 / 样品 / 模板三块。
 *
 * 聚合读取沿用旧「业务全景」的 `usePanorama`，不新增 API；
 * 具体列表仍在 `/panorama/customers`、`/panorama/samples` 上，深链不迁移。
 */
export default function ResourcesPage() {
  return <PanoramaOverview variant="resources" />;
}
