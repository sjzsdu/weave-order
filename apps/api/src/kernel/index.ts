import type { Db } from "@weave-order/db";
import { listAuditLog } from "./audit";
import { CustomerService } from "./customers.service";
import { QuoteService } from "./quotes.service";
import { SampleService } from "./samples.service";
import { ShipmentService } from "./shipments.service";

/**
 * 确定性内核的唯一装配入口。
 *
 * 这里的每个 service 都是业务表的唯一写入者；工具层只能拿到这个对象，
 * 拿不到 Db / 连接池，因此不存在「绕过内核改账本」的编码路径。
 */
export function createKernel(db: Db) {
  const customers = new CustomerService(db);
  const samples = new SampleService(db);
  const shipments = new ShipmentService(db, customers);
  const quotes = new QuoteService(db, customers, samples);

  return {
    customers,
    samples,
    shipments,
    quotes,
    audit: {
      list: (limit?: number) => listAuditLog(db, limit),
    },
  };
}

export type Kernel = ReturnType<typeof createKernel>;

export { KernelError, isKernelError, errorChainMessage } from "./errors";
export type { KernelContext } from "./audit";
export { formatMoney } from "./money";
