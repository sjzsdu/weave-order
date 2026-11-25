import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditLog, items } from "@weave-order/db";
import type { Db, ItemRow } from "@weave-order/db";
import type { AuditWrite } from "../src/kernel/audit";
import { ItemService } from "../src/kernel/items.service";
import {
  createItemTransitionToken,
  verifyItemTransitionToken,
} from "../src/kernel/item-transition-token";

const audit = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("../src/kernel/audit", () => ({ appendAudit: audit.append }));
const secret = "test-secret";
const ctx = { actor: { type: "HUMAN" as const, id: "owner", role: "OWNER" as const } };
const mismatch = { details: { reason: "ITEM_TRANSITION_UNDO_MISMATCH" } };

function fixture() {
  let row: ItemRow = {
    id: randomUUID(),
    tenantId: randomUUID(),
    status: "IN_PROGRESS",
    customerId: null,
    sampleId: null,
    quantityMilli: 1000,
    unit: "meter",
    currentStage: "正在核对客户价格",
    nextAction: "保留原始下一步",
    sourceIntentId: null,
    createdBy: "owner",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let latest: AuditWrite | undefined;
  const records: AuditWrite[] = [];
  audit.append.mockImplementation((_tx: unknown, _ctx: unknown, event: AuditWrite) => {
    latest = event;
    records.push(event);
    return Promise.resolve();
  });
  // 数据库适配器只模拟查询/锁/事务，迁移校验和票据校验都运行真实 service。
  function query(rows: () => unknown[]) {
    const builder: Record<string, unknown> = {};
    for (const name of ["where", "orderBy", "limit", "for"]) builder[name] = () => builder;
    builder.then = (resolve: (value: unknown[]) => unknown) =>
      Promise.resolve(rows()).then(resolve);
    return builder;
  }
  const db = {
    select: () => ({
      from: (table: unknown) =>
        query(() => (table === items ? [row] : table === auditLog && latest ? [latest] : [])),
    }),
    update: () => ({
      set: (patch: Partial<ItemRow>) => ({
        where: () => ({
          returning: () => {
            row = { ...row, ...patch };
            return Promise.resolve([row]);
          },
        }),
      }),
    }),
    transaction: (fn: (tx: unknown) => unknown) => Promise.resolve(fn(db)),
  };
  return {
    service: new ItemService(db as unknown as Db, row.tenantId, secret),
    row: () => row,
    change: (patch: Partial<ItemRow>) => {
      row = { ...row, ...patch };
    },
    records,
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("事项状态撤销", () => {
  it("恢复完整快照并双写变更/撤销审计；同一票据不可重放", async () => {
    const f = fixture();
    const original = { ...f.row() };
    const changed = await f.service.transition(original.id, { status: "WAITING_INPUT" }, ctx);
    expect(changed.undoToken).toBeTruthy();
    expect(Date.parse(changed.undoUntil!) - Date.now()).toBeLessThanOrEqual(60_000);
    const reverted = await f.service.undoTransition(
      original.id,
      { undoToken: changed.undoToken },
      ctx,
    );
    expect(reverted.item).toMatchObject({
      status: original.status,
      currentStage: original.currentStage,
      nextAction: original.nextAction,
    });
    expect(f.records.map((r) => r.action)).toEqual(["ITEM_STATUS_CHANGED", "ITEM_STATUS_REVERTED"]);
    await expect(
      f.service.undoTransition(original.id, { undoToken: changed.undoToken }, ctx),
    ).rejects.toMatchObject(mismatch);
  });

  it("60 秒后拒绝撤销且不写审计", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const changed = await f.service.transition(f.row().id, { status: "WAITING_INPUT" }, ctx);
    vi.advanceTimersByTime(60_000);
    await expect(
      f.service.undoTransition(f.row().id, { undoToken: changed.undoToken }, ctx),
    ).rejects.toMatchObject(mismatch);
    expect(f.records).toHaveLength(1);
  });

  it("篡改票据被拒绝", async () => {
    const f = fixture();
    const changed = await f.service.transition(f.row().id, { status: "WAITING_INPUT" }, ctx);
    await expect(
      f.service.undoTransition(f.row().id, { undoToken: changed.undoToken + "x" }, ctx),
    ).rejects.toMatchObject(mismatch);
  });

  it("当前状态已被他人修改时拒绝覆盖", async () => {
    const f = fixture();
    const changed = await f.service.transition(f.row().id, { status: "WAITING_INPUT" }, ctx);
    f.change({ status: "IN_PROGRESS" });
    await expect(
      f.service.undoTransition(f.row().id, { undoToken: changed.undoToken }, ctx),
    ).rejects.toMatchObject(mismatch);
  });

  it.each(["COMPLETED", "CLOSED"] as const)("当前事项已进入 %s 则拒绝撤销", async (status) => {
    const f = fixture();
    const changed = await f.service.transition(f.row().id, { status: "WAITING_INPUT" }, ctx);
    f.change({ status });
    await expect(
      f.service.undoTransition(f.row().id, { undoToken: changed.undoToken }, ctx),
    ).rejects.toMatchObject({ details: { reason: "ITEM_TERMINAL" } });
  });

  it("返回相同状态也不能复用旧票据（ABA）", async () => {
    const f = fixture();
    const first = await f.service.transition(f.row().id, { status: "WAITING_INPUT" }, ctx);
    await f.service.transition(f.row().id, { status: "IN_PROGRESS" }, ctx);
    await f.service.transition(f.row().id, { status: "WAITING_INPUT" }, ctx);
    await expect(
      f.service.undoTransition(f.row().id, { undoToken: first.undoToken }, ctx),
    ).rejects.toMatchObject(mismatch);
  });

  it("同状态下更新过内容，也不能覆盖", async () => {
    const f = fixture();
    const changed = await f.service.transition(f.row().id, { status: "WAITING_INPUT" }, ctx);
    f.change({ updatedAt: new Date(f.row().updatedAt.getTime() + 1), nextAction: "新的下一步" });
    await expect(
      f.service.undoTransition(f.row().id, { undoToken: changed.undoToken }, ctx),
    ).rejects.toMatchObject(mismatch);
  });

  it("租户、事项和操作者必须匹配", async () => {
    const f = fixture();
    const changed = await f.service.transition(f.row().id, { status: "WAITING_INPUT" }, ctx);
    const input = { undoToken: changed.undoToken };
    await expect(f.service.undoTransition(randomUUID(), input, ctx)).rejects.toMatchObject(
      mismatch,
    );
    await expect(
      f.service.undoTransition(f.row().id, input, { actor: { ...ctx.actor, id: "other" } }),
    ).rejects.toMatchObject(mismatch);
    const payload = verifyItemTransitionToken(secret, changed.undoToken!);
    await expect(
      f.service.undoTransition(
        f.row().id,
        {
          undoToken: createItemTransitionToken(secret, { ...payload, tenantId: randomUUID() }),
        },
        ctx,
      ),
    ).rejects.toMatchObject(mismatch);
  });

  it.each(["COMPLETED", "CLOSED"] as const)("签名票据也不能恢复至终态 %s", async (from) => {
    const f = fixture();
    const changed = await f.service.transition(f.row().id, { status: "WAITING_INPUT" }, ctx);
    const payload = verifyItemTransitionToken(secret, changed.undoToken!);
    await expect(
      f.service.undoTransition(
        f.row().id,
        {
          undoToken: createItemTransitionToken(secret, { ...payload, from }),
        },
        ctx,
      ),
    ).rejects.toMatchObject({ details: { reason: "ITEM_TERMINAL" } });
  });

  it("关闭不发可撤销票据", async () => {
    const f = fixture();
    const closed = await f.service.transition(f.row().id, { status: "CLOSED" }, ctx);
    expect(closed.undoToken).toBeUndefined();
  });
});
