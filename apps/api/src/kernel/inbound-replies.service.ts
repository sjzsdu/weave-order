import { and, eq } from "drizzle-orm";
import { inboundMessages } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { InboundMessage, IngestReplyInput } from "@weave-order/schema";
import type { JsonValue } from "@weave-order/schema";
import { redactSensitiveText } from "../platform/privacy";
import { KernelError } from "./errors";

type Row = typeof inboundMessages.$inferSelect;

/** 截图 → 文本（多模态 OCR）；由 platform 层注入，kernel 不直接依赖 platform。 */
export type ImageToText = (imageUrl: string) => Promise<{ text: string }>;

export interface IngestReplyOptions {
  ocr?: ImageToText;
  now?: () => Date;
}

function mapRow(row: Row): InboundMessage {
  return InboundMessage.parse({
    id: row.id,
    tenantId: row.tenantId,
    channel: row.channel,
    externalId: row.externalId,
    customerRef: row.customerRef,
    text: row.text,
    receivedAt: row.receivedAt.toISOString(),
    rawPayload: row.rawPayload,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * 手工录入客户回复的落库端。
 *
 * 支持两路输入：粘贴文本（channel=manual）或上传截图（channel=screenshot，经多模态 OCR 抽取）。
 * 文本入库前统一脱敏；`(tenant_id, channel, external_id)` 唯一，重放/重复提交只落一条。
 */
export class InboundRepliesService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async ingest(raw: unknown, options: IngestReplyOptions = {}): Promise<InboundMessage> {
    const input = IngestReplyInput.parse(raw);
    const now = options.now?.() ?? new Date();

    let text: string;
    let rawPayload: JsonValue;
    if (input.channel === "screenshot") {
      if (!input.imageUrl) {
        throw new KernelError("KERNEL_REJECTED", "截图录入需要提供 imageUrl", {
          reason: "MISSING_IMAGE",
        });
      }
      if (!options.ocr) {
        throw new KernelError("KERNEL_REJECTED", "截图识别需要启用 litellm 视觉模型", {
          reason: "OCR_UNAVAILABLE",
        });
      }
      const extracted = await options.ocr(input.imageUrl);
      text = extracted.text;
      rawPayload = { imageUrl: input.imageUrl };
    } else {
      if (!input.text) {
        throw new KernelError("KERNEL_REJECTED", "文本录入需要提供 text", {
          reason: "MISSING_TEXT",
        });
      }
      text = input.text;
      rawPayload = null;
    }

    // 入库前脱敏（铁律 G9）；空文本直接拒绝，不落半成品。
    const redacted = redactSensitiveText(text).trim();
    if (!redacted) {
      throw new KernelError("KERNEL_REJECTED", "客户回复内容为空，无法入库", {
        reason: "EMPTY_TEXT",
      });
    }

    const inserted = await this.db
      .insert(inboundMessages)
      .values({
        tenantId: this.tenantId,
        channel: input.channel,
        externalId: input.externalId,
        customerRef: input.customerRef ?? null,
        text: redacted,
        receivedAt: now,
        rawPayload,
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
}
