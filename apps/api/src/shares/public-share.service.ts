import { withTenantSession } from "@weave-order/db";
import type { Pool } from "pg";
import { createKernel, parseShareToken, QuoteLinkError } from "../kernel";
import type {
  CustomerAcceptQuoteResult,
  CustomerAskQuestionResult,
  CustomerQuotePage as CustomerPage,
} from "@weave-order/schema";
import { loadEnv } from "../platform/env";
import type { ShareVisitor } from "../kernel/shares.service";

/**
 * 公开报价链接的唯一入口。
 *
 * 顺序：验签 token → 从 token 拿到 tenantId → 打开该租户的 RLS 会话 → 内核。
 * 因此公开路由不需要、也没有一条跨租户的 owner 连接去「猜」租户；
 * 每个查询都仍在 `app.tenant_id` 约束下执行。
 */
export class PublicShareService {
  private readonly secret: string;
  private readonly publicAppUrl: string;

  constructor(private readonly pool: Pool) {
    const env = loadEnv();
    this.secret = env.QUOTE_SHARE_SECRET;
    this.publicAppUrl = env.PUBLIC_APP_URL;
  }

  private async withShare<T>(
    token: string,
    fn: (shares: ReturnType<typeof createKernel>["shares"], shareId: string) => Promise<T>,
  ): Promise<T> {
    const payload = parseShareToken(token, this.secret);
    if (!payload) {
      throw new QuoteLinkError("INVALID_LINK", "链接无效，请联系您的业务员重新获取");
    }
    return withTenantSession(this.pool, payload.t, async (db) => {
      const kernel = createKernel(db, undefined, {
        tenantId: payload.t,
        shareSecret: this.secret,
        publicAppUrl: this.publicAppUrl,
      });
      return fn(kernel.shares, payload.s);
    });
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
