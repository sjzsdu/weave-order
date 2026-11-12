import { customerContexts, decisionDeltas } from "@weave-order/db";
import type { Tx } from "@weave-order/db";
import type { DecisionDelta, JsonValue, ScenarioTag } from "@weave-order/schema";
import { and, eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";

export interface DecisionDeltaInput {
  customerId: string;
  entityType: "quote" | "order" | "sample_shipment";
  entityId: string;
  /** 被修改的字段，如 `unit_price_0` / `quote_status`。 */
  field: string;
  originalValue: JsonValue;
  modifiedValue: JsonValue;
  scenarioTag?: ScenarioTag;
  reasonId?: string | null;
  note?: string | null;
}

const CONTEXT_DELTA_LIMIT = 50;

/**
 * 在业务写入的同一事务内落一条决策增量。
 *
 * 两处落地：
 * 1. `decision_deltas` 表：完整、可聚合的训练信号；
 * 2. `customer_contexts.decision_deltas`：最近 50 条，供报价建议快速读取。
 *
 * 任何一处失败都会让整个业务事务回滚，不存在「改了价但没有训练信号」。
 */
export async function appendDecisionDeltaWithin(
  tx: Tx,
  tenantId: string,
  ctx: KernelContext,
  input: DecisionDeltaInput,
): Promise<void> {
  const rows = await tx
    .insert(decisionDeltas)
    .values({
      tenantId,
      customerId: input.customerId,
      entityType: input.entityType,
      entityId: input.entityId,
      field: input.field,
      originalValue: input.originalValue,
      modifiedValue: input.modifiedValue,
      scenarioTag: input.scenarioTag ?? "PRICING",
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      reasonId: input.reasonId ?? null,
      note: input.note ?? null,
    })
    .returning({ id: decisionDeltas.id });
  const row = rows[0];
  if (!row) {
    throw new Error("决策增量写入未返回记录");
  }

  const contextRows = await tx
    .select()
    .from(customerContexts)
    .where(
      and(
        eq(customerContexts.customerId, input.customerId),
        eq(customerContexts.tenantId, tenantId),
      ),
    )
    .limit(1);
  const context = contextRows[0];
  if (context) {
    const delta: DecisionDelta = {
      id: row.id,
      field: input.field,
      originalValue: input.originalValue,
      modifiedValue: input.modifiedValue,
      scenarioTag: input.scenarioTag ?? "PRICING",
      actor: ctx.actor.type === "AGENT" ? "AGENT" : "HUMAN",
      changedAt: new Date().toISOString(),
    };
    const next = [...context.decisionDeltas, delta].slice(-CONTEXT_DELTA_LIMIT);
    await tx
      .update(customerContexts)
      .set({ decisionDeltas: next, updatedAt: new Date() })
      .where(
        and(
          eq(customerContexts.customerId, input.customerId),
          eq(customerContexts.tenantId, tenantId),
        ),
      );
  }

  await appendAudit(
    tx,
    ctx,
    {
      action: "DECISION_DELTA_RECORDED",
      entityType: input.entityType,
      entityId: input.entityId,
      before: { field: input.field, value: input.originalValue },
      after: {
        field: input.field,
        value: input.modifiedValue,
        reasonId: input.reasonId ?? null,
      },
    },
    tenantId,
  );
}
