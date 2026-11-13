import type { Db } from "@weave-order/db";
import { PrintCenterSnapshot } from "@weave-order/schema";
import { PrintDeviceService } from "./print-devices.service";
import { PrintJobService } from "./print-jobs.service";
import { PrintTemplateService } from "./print-templates.service";
import { PrintViewService } from "./print-view.service";

export interface PrintCenter {
  views: PrintViewService;
  templates: PrintTemplateService;
  jobs: PrintJobService;
  devices: PrintDeviceService;
  snapshot(): Promise<PrintCenterSnapshot>;
}

/**
 * 打印中心组合根：视图 / 模板 / 队列 / 设备共享同一租户绑定。
 * 业务表只读；打印任务、箱与标签的写入都从这里走并同事务留审计。
 */
export function createPrintCenter(db: Db, tenantId: string): PrintCenter {
  const views = new PrintViewService(db, tenantId);
  const templates = new PrintTemplateService(db, tenantId);
  const jobs = new PrintJobService(db, tenantId, views, templates);
  const devices = new PrintDeviceService(db, tenantId);
  return {
    views,
    templates,
    jobs,
    devices,
    async snapshot() {
      const [queue, templateList, deviceList, logs, pendingShipments] = await Promise.all([
        jobs.list({ limit: 40 }),
        templates.list(),
        devices.list(),
        jobs.logs(30),
        views.listPendingShipping(10),
      ]);
      return PrintCenterSnapshot.parse({
        queue,
        templates: templateList,
        devices: deviceList,
        logs,
        pendingShipments,
      });
    },
  };
}

export { PrintError } from "./template-engine";
export type { PrintErrorCode } from "./template-engine";
export { buildBoxQr, parseBoxQr } from "./qr";
export { renderBoxLabel, renderTestLabel } from "./labels";
export { renderA4Pdf, renderBuiltinA4Pdf } from "./pdf";
export { analyzeTemplate, renderTemplate } from "./template-engine";
