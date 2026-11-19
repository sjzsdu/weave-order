import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { inboundMessages } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { InboundMessage, IngestReplyInput } from "@weave-order/schema";
import type { JsonValue } from "@weave-order/schema";
import { redactSensitiveText } from "../platform/privacy";
import { KernelError } from "./errors";

type Row = typeof inboundMessages.$inferSelect;

/** 截图 → 文本（多模态 OCR）；由 platform 层注入，kernel 不直接依赖 platform。 */
export type ImageToText = (imageUrl: string) => Promise<{ text: string }>;

export interface InboundServiceOptions {
  /** objectKey → 可读 URL（签名或 CDN）；截图识别前必须解出真地址。 */
  resolveImageUrl?: (objectKey: string) => Promise<string>;
  /** 原始 payload 保留天数，默认取环境变量（30）。 */
  retentionDays?: number;
  now?: () => Date;
}

export interface IngestReplyOptions {
  ocr?: ImageToText;
  now?: () => Date;
}

const DEFAULT_RETENTION_DAYS = 30;
const OBJECT_KEY_PATTERN =
  /^tenant\/([0-9a-fA-F-]{36})\/inbound\/[0-9a-fA-F-]{36}\.(jpg|png|webp)$/;

function mapRow(row: Row): InboundMessage {
  return InboundMessage.parse({
    id: row.id,
    tenantId: row.tenantId,
    channel: row.channel,
    externalId: row.externalId,
    customerId: row.customerId,
    shipmentId: row.shipmentId,
    customerRef: row.customerRef,
    text: row.text,
    receivedAt: row.receivedAt.toISOString(),
    rawPayload: row.rawPayload,
    rawPayloadExpiresAt: row.rawPayloadExpiresAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
    classification: row.classification ?? null,
    quoteDraftId: row.quoteDraftId ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * 手工录入客户回复的落库端。
 *
 * 支持两路输入：粘贴文本（channel=manual）或上传截图（channel=screenshot，经多模态 OCR 抽取）。
 * 文本入库前统一脱敏；`(tenant_id, channel, external_id)` 唯一，重放/重复提交只落一条。
 * 截图只接受 presign 签出的 `tenant/<tenant>/inbound/<uuid>.<ext>` key，
 * 服务端自己解 URL，不接受任意外链（避免 SSRF 与超长 data URL）。
 */
export class InboundRepliesService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly options: InboundServiceOptions = {},
  ) {}

  async ingest(raw: unknown, options: IngestReplyOptions = {}): Promise<InboundMessage> {
    const input = IngestReplyInput.parse(raw);
    const now = options.now?.() ?? this.options.now?.() ?? new Date();

    let text: string;
    let rawPayload: JsonValue;
    if (input.channel === "screenshot") {
      const objectKey = input.objectKey as string;
      const match = OBJECT_KEY_PATTERN.exec(objectKey);
      if (!match || match[1] !== this.tenantId) {
        throw new KernelError("KERNEL_REJECTED", "objectKey 不是本接口签发的截图路径", {
          reason: "MEDIA_KEY_INVALID",
        });
      }
      if (!options.ocr) {
        throw new KernelError(
          "KERNEL_REJECTED",
          "截图识别需要配置 openai-compatible 企业模型网关与视觉模型",
          { reason: "OCR_UNAVAILABLE" },
        );
      }
      const resolveUrl = this.options.resolveImageUrl;
      if (!resolveUrl) {
        throw new KernelError("KERNEL_REJECTED", "对象存储未配置，无法读取截图", {
          reason: "MEDIA_STORAGE_UNAVAILABLE",
        });
      }
      const imageUrl = await resolveUrl(objectKey);
      const extracted = await options.ocr(imageUrl);
      text = extracted.text;
      // 只存 key，不存签名 URL：签名参数会过期，也不该长期留在库里。
      rawPayload = { objectKey };
    } else {
      text = input.text as string;
      rawPayload = null;
    }

    // 入库前脱敏（铁律 G9）；空文本直接拒绝，不落半成品。
    const redacted = redactSensitiveText(text).trim();
    if (!redacted) {
      throw new KernelError("KERNEL_REJECTED", "客户回复内容为空，无法入库", {
        reason: "EMPTY_TEXT",
      });
    }

    const retentionDays = this.options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const inserted = await this.db
      .insert(inboundMessages)
      .values({
        tenantId: this.tenantId,
        customerId: input.customerId,
        shipmentId: input.shipmentId ?? null,
        channel: input.channel,
        externalId: input.externalId,
        customerRef: input.customerRef ?? null,
        text: redacted,
        receivedAt: now,
        rawPayload,
        rawPayloadExpiresAt: rawPayload === null ? null : addDays(now, Math.max(retentionDays, 1)),
      })
      .onConflictDoNothing({
        target: [inboundMessages.tenantId, inboundMessages.channel, inboundMessages.externalId],
      })
      .returning();

    if (inserted[0]) return mapRow(inserted[0]);

    // 幂等：同 (tenant, channel, externalId) 已存在，返回既有行，不重复入库。
    const existing = await this.db
      .select()
      .from(inboundMessages)
      .where(
        and(
          eq(inboundMessages.tenantId, this.tenantId),
          eq(inboundMessages.channel, input.channel),
          eq(inboundMessages.externalId, input.externalId),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) {
      throw new KernelError("KERNEL_REJECTED", "客户回复入库失败", {
        reason: "INSERT_RETURNED_NO_ROW",
      });
    }
    return mapRow(row);
  }

  /** 客户最近录入的回复（工作台用；时间线另有合并查询）。 */
  async listByCustomer(customerId: string, limit = 20): Promise<InboundMessage[]> {
    const rows = await this.db
      .select()
      .from(inboundMessages)
      .where(
        and(
          eq(inboundMessages.tenantId, this.tenantId),
          eq(inboundMessages.customerId, customerId),
        ),
      )
      .orderBy(desc(inboundMessages.receivedAt))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map(mapRow);
  }

  /** 按幂等键查已有回复：用于「重复提交返回首次结果」，不再调用模型。 */
  async findByExternalId(
    channel: InboundMessage["channel"],
    externalId: string,
  ): Promise<InboundMessage | null> {
    const rows = await this.db
      .select()
      .from(inboundMessages)
      .where(
        and(
          eq(inboundMessages.tenantId, this.tenantId),
          eq(inboundMessages.channel, channel),
          eq(inboundMessages.externalId, externalId),
        ),
      )
      .limit(1);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** 写入首次处理结果（结论 + 草稿 id），供重放时原样返回。 */
  async recordProcessing(
    id: string,
    result: { classification: unknown; quoteDraftId: string | null },
  ): Promise<void> {
    await this.db
      .update(inboundMessages)
      .set({
        classification: result.classification as JsonValue,
        quoteDraftId: result.quoteDraftId,
      })
      .where(and(eq(inboundMessages.tenantId, this.tenantId), eq(inboundMessages.id, id)));
  }

  /** 标记为已处理：录入时若已同步识别，就不再交给跟进线程重复识别。 */
  async markConsumed(id: string): Promise<void> {
    await this.db
      .update(inboundMessages)
      .set({ consumedAt: this.options.now?.() ?? new Date() })
      .where(
        and(
          eq(inboundMessages.tenantId, this.tenantId),
          eq(inboundMessages.id, id),
          isNull(inboundMessages.consumedAt),
        ),
      );
  }

  /**
   * 取走该客户最新一条未消费的回复（可限定寄样单）。
   * 用 `consumed_at IS NULL` 条件更新做抢占：并发下只有一方拿到，保证「一条回复只识别一次」。
   */
  async claimLatest(input: {
    customerId: string;
    shipmentId?: string;
  }): Promise<InboundMessage | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const conditions = [
        eq(inboundMessages.tenantId, this.tenantId),
        eq(inboundMessages.customerId, input.customerId),
        isNull(inboundMessages.consumedAt),
      ];
      if (input.shipmentId) {
        conditions.push(
          sql`(${inboundMessages.shipmentId} = ${input.shipmentId} OR ${inboundMessages.shipmentId} IS NULL)`,
        );
      }
      const rows = await this.db
        .select()
        .from(inboundMessages)
        .where(and(...conditions))
        .orderBy(desc(inboundMessages.receivedAt))
        .limit(1);
      const candidate = rows[0];
      if (!candidate) return null;

      const claimed = await this.db
        .update(inboundMessages)
        .set({ consumedAt: this.options.now?.() ?? new Date() })
        .where(and(eq(inboundMessages.id, candidate.id), isNull(inboundMessages.consumedAt)))
        .returning();
      if (claimed[0]) return mapRow(claimed[0]);
      // 抢输了：重新读下一条。
    }
    return null;
  }
}
