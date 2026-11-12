import { DEFAULT_TENANT_ID } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createEmbeddingProvider } from "../platform/embedding";
import type { EmbeddingProvider } from "../platform/embedding";
import { listAuditLog } from "./audit";
import { CustomerService } from "./customers.service";
import { ImportService } from "./import.service";
import { QuoteService } from "./quotes.service";
import { SampleService } from "./samples.service";
import { SearchService } from "./search.service";
import { ShipmentService } from "./shipments.service";
import { TenancyService } from "./tenancy.service";

export interface KernelOptions {
  /**
   * 内核绑定的租户。网关为每个已认证请求创建一个绑定了 tenantId 的内核；
   * 未传时退回默认演示租户（仅本地演示 / 单租户脚本）。
   */
  tenantId?: string;
}

/**
 * 确定性内核的唯一装配入口。
 *
 * 这里的每个 service 都是业务表的唯一写入者；工具层只能拿到这个对象，
 * 拿不到 Db / 连接池，因此不存在「绕过内核改账本」的编码路径。
 *
 * 多租户：`db` 必须是已设置 `app.tenant_id` 的会话连接（生产），
 * 或 owner 连接（迁移 / 平台控制面）。绑定租户用于写 tenant_id 与审计。
 */
export function createKernel(
  db: Db,
  embedder: EmbeddingProvider = createEmbeddingProvider(),
  options: KernelOptions = {},
) {
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const customers = new CustomerService(db, tenantId);
  const samples = new SampleService(db, embedder, tenantId);
  const shipments = new ShipmentService(db, customers, tenantId);
  const quotes = new QuoteService(db, customers, samples, tenantId);
  const search = new SearchService(db, embedder, tenantId);
  const importing = new ImportService(db, customers, samples, embedder, tenantId);
  const tenancy = new TenancyService(db);

  return {
    tenantId,
    customers,
    samples,
    shipments,
    quotes,
    search,
    importing,
    tenancy,
    audit: {
      list: (limit?: number) => listAuditLog(db, limit, tenantId),
    },
  };
}

export type Kernel = ReturnType<typeof createKernel>;

export { KernelError, isKernelError, errorChainMessage } from "./errors";
export type { KernelContext } from "./audit";
export type { EmbeddingProvider } from "../platform/embedding";
export { formatMoney } from "./money";
