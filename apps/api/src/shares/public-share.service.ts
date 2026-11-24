import {
  CustomerAcceptQuoteResult,
  CustomerAskQuestionResult,
} from "@weave-order/schema";
import type { CustomerQuotePage as CustomerPage } from "@weave-order/schema";
import { parseShareToken, QuoteLinkError } from "../kernel";
import type { Kernel } from "../kernel";
import type { ShareVisitor } from "../kernel/shares.service";
import { withKernelScope } from "../kernel/tenant-scope";
import type { TenantPool } from "../kernel/tenant-scope";
import { loadEnv } from "../platform/env";

/**
 * 公开报价链接的唯一入口。
 *
 * 顺序：验签 token → 从 token 拿到 tenantId → 打开该租户的 RLS 会话 → 内核。
 * 因此公开路由不需要、也没有一条跨租户的 owner 连接去「猜」租户；
 * 每个查询都仍在 `app.tenant_id` 约束下执行。
 *
 * 会话与连接由 kernel.tenant-scope 提供：这里只能拿到 kernel，拿不到 db。
 */
export class PublicShareService {
  private readonly secret: string;
  private readonly publicAppUrl: string;

  constructor(private readonly pool: TenantPool) {
    const env = loadEnv();
    this.secret = env.QUOTE_SHARE_SECRET;
    this.publicAppUrl = env.PUBLIC_APP_URL;
  }

  private async withShare<T>(
    token: string,
    fn: (shares: Kernel["shares"], shareId: string) => Promise<T>,
  ): Promise<T> {
    const payload = parseShareToken(token, this.secret);
    if (!payload) {
      throw new QuoteLinkError("INVALID_LINK", "链接无效，请联系您的业务员重新获取");
    }
    return withKernelScope(
      this.pool,
      payload.t,
      (kernel) => fn(kernel.shares, payload.s),
      { shareSecret: this.secret, publicAppUrl: this.publicAppUrl },
    );
  }

  view(
    token: string,
    visitor: ShareVisitor,
    options: { track?: boolean } = {},
  ): Promise<CustomerPage> {
    return this.withShare(token, (shares, shareId) =>
      shares.viewForCustomer(shareId, token, visitor, options),
    );
  }

  accept(token: string, input: unknown, visitor: ShareVisitor): Promise<CustomerAcceptQuoteResult> {
    return this.withShare(token, (shares, shareId) =>
      shares.acceptForCustomer(shareId, token, input, visitor),
    );
  }

  ask(token: string, input: unknown, visitor: ShareVisitor): Promise<CustomerAskQuestionResult> {
    return this.withShare(token, (shares, shareId) =>
      shares.askForCustomer(shareId, token, input, visitor),
    );
  }

  recordPdf(token: string, visitor: ShareVisitor): Promise<void> {
    return this.withShare(token, (shares, shareId) =>
      shares.recordPdfDownload(shareId, token, visitor),
    );
  }
}
