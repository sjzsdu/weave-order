import type {
  Currency,
  Money,
  QuoteLineItem,
  QuoteShare,
  QuoteStatus,
  RevisionRequest,
} from "@weave-order/schema";

/** mock 服务端的报价存储行（比契约多一个 version，模拟并发基线）。 */
export interface QuoteRecord {
  id: string;
  tenantId: string;
  customerId: string;
  status: QuoteStatus;
  currency: Currency;
  items: QuoteLineItem[];
  subtotal: Money;
  total: Money;
  amountsComputedByKernel: true;
  validityDays: number;
  expiresAt: string;
  createdAt: string;
  remarks: string | null;
  version: number;
}

export interface MockShareRecord {
  share: QuoteShare;
  events: Array<{ type: string; at: string }>;
}

export interface MockState {
  quotes: QuoteRecord[];
  approvals: import("@weave-order/schema").ApprovalItem[];
  revisions: RevisionRequest[];
  shares: MockShareRecord[];
  audit: import("@weave-order/schema").AuditLogEntry[];
  seq: number;
  offline: boolean;
}

export interface MockStorage {
  load(): MockState | null;
  save(state: MockState): void;
  clear(): void;
}
