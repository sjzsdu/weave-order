import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { withTenantSession } from "@weave-order/db";
import { samples, tenants } from "@weave-order/db";
import { PublicSampleCard } from "@weave-order/schema";
import { QuoteLinkError } from "../kernel";
import { parseSampleCardToken } from "../kernel/share-token";
import { loadEnv } from "../platform/env";

/**
 * 样卡二维码的公开面。
 *
 * 铁律：扫码只回答两个问题——「这是哪个样品」「找谁」。
 * 响应里没有客户、价格、成本、报价单号，也没有内部 UUID；
 * 链接是签名 token，改一个字符就失效，不能被拿来枚举别家样品。
 */
export class PublicSampleCardService {
  private readonly secret: string;

  constructor(private readonly pool: Pool) {
    this.secret = loadEnv().QUOTE_SHARE_SECRET;
  }

  async view(token: string): Promise<PublicSampleCard> {
    const payload = parseSampleCardToken(token, this.secret);
    if (!payload) {
      throw new QuoteLinkError("INVALID_LINK", "链接无效，请扫描样卡上的二维码");
    }
    return withTenantSession(this.pool, payload.t, async (db) => {
      const sampleRows = await db
        .select({ code: samples.code })
        .from(samples)
        .where(and(eq(samples.tenantId, payload.t), eq(samples.code, payload.c)))
        .limit(1);
      const sample = sampleRows[0];
      if (!sample) {
        // 样品已删除或编号已改：与假链接同一句话，不区分原因。
        throw new QuoteLinkError("INVALID_LINK", "链接无效，请扫描样卡上的二维码");
      }

      const tenantRows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, payload.t))
        .limit(1);
      const tenant = tenantRows[0];
      const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
      const raw = settings.salesContact;
      const contact =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const name =
        typeof contact.name === "string" && contact.name.trim() ? contact.name.trim() : "";
      const phone =
        typeof contact.phone === "string" && contact.phone.trim()
          ? contact.phone.trim()
          : typeof settings.printPhone === "string" && settings.printPhone.trim()
            ? settings.printPhone.trim()
            : "";

      return PublicSampleCard.parse({
        sampleCode: sample.code,
        salesperson: {
          // 未配置业务员时退回公司名，而不是让人在页面上看到空白。
          name: name || tenant?.name?.trim() || "",
          phone,
        },
      });
    });
  }
}
