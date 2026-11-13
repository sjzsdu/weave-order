import { describe, expect, it } from "vitest";
import type { Tx } from "@weave-order/db";
import { appendAudit } from "../src/kernel/audit";
import type { KernelContext } from "../src/kernel/audit";

/**
 * 审计写入的角色快照：appendAudit 除 actorType / actorId 外，还要落 actorRole，
 * 让「当时他有没有这个权限」在事后可还原（智能体 / 系统无角色则存 null）。
 * 用假 tx 捕获 insert 的 values，不依赖真实数据库。
 */
function captureTx(): { tx: Tx; captured: unknown[] } {
  const captured: unknown[] = [];
  const tx = {
    insert: () => ({
      values: (value: unknown) => {
        captured.push(value);
        return Promise.resolve();
      },
    }),
  } as unknown as Tx;
  return { tx, captured };
}

describe("审计写入：actorRole 角色快照", () => {
  it("人类审批人写入 actorRole，审批时点权限可还原", async () => {
    const { tx, captured } = captureTx();
    const ctx: KernelContext = {
      actor: { type: "HUMAN", id: "approver-1", role: "SALES" },
    };
    await appendAudit(tx, ctx, {
      action: "QUOTE_CONFIRMED",
      entityType: "quote",
      entityId: "00000000-0000-4000-8000-000000000001",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      actorType: "HUMAN",
      actorId: "approver-1",
      actorRole: "SALES",
      action: "QUOTE_CONFIRMED",
    });
  });

  it("智能体 / 系统无角色，actorRole 存 null", async () => {
    const { tx, captured } = captureTx();
    await appendAudit(
      tx,
      { actor: { type: "AGENT", id: "quoting-agent" } },
      {
        action: "QUOTE_DRAFT_GENERATED",
        entityType: "quote",
        entityId: "00000000-0000-4000-8000-000000000002",
      },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      actorType: "AGENT",
      actorId: "quoting-agent",
      actorRole: null,
    });
  });
});
