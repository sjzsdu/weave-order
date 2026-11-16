import type { Membership } from "@weave-order/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KernelError } from "../src/kernel/errors";
import { OnboardingService, TeamActionError } from "../src/onboarding/onboarding.service";
import type { DatabaseProvider } from "../src/platform/database.provider";

/**
 * 撤销邀请的服务层单测。
 *
 * 内核（删除 + 审计 + 租户隔离）由集成测试覆盖；这里只锁两件事：
 * 1. 能力门槛在服务端判定，SALES 一律 403，且根本不碰内核；
 * 2. 内核拒绝被翻译成可判别的人话（404 不存在 / 409 对方已接受）。
 */
const mocks = vi.hoisted(() => ({ revokeMembership: vi.fn() }));

vi.mock("../src/kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel")>();
  return {
    ...actual,
    createKernel: () => ({ tenancy: { revokeMembership: mocks.revokeMembership } }),
  };
});

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const INVITE_ID = "22222222-2222-4222-8222-222222222222";

function membership(role: Membership["role"]): Membership {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tenantId: TENANT_ID,
    subject: "boss@example.com",
    casdoorOrg: null,
    role,
    dataScope: "ALL",
    teamId: null,
    approvalLimitAmount: null,
    status: "ACTIVE",
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
  };
}

function service() {
  return new OnboardingService({ handle: { db: {} } } as unknown as DatabaseProvider);
}

beforeEach(() => {
  mocks.revokeMembership.mockReset();
});

describe("OnboardingService.revokeInvite", () => {
  it("撤销待接受的邀请：按调用者租户删除，并写入审计上下文", async () => {
    mocks.revokeMembership.mockResolvedValue(undefined);

    await service().revokeInvite(membership("OWNER"), INVITE_ID, "老板");

    expect(mocks.revokeMembership).toHaveBeenCalledTimes(1);
    const [tenantId, membershipId, ctx] = mocks.revokeMembership.mock.calls[0] as [
      string,
      string,
      { actor: { type: string; id: string; role: string }; tenantId: string },
    ];
    expect(tenantId).toBe(TENANT_ID);
    expect(membershipId).toBe(INVITE_ID);
    expect(ctx.actor).toMatchObject({ type: "HUMAN", role: "OWNER" });
    // 内核永远只按调用者自己的租户查：跨租户 membershipId 查不到，自然 404。
    expect(ctx.tenantId).toBe(TENANT_ID);
  });

  it("主管也可以撤销", async () => {
    mocks.revokeMembership.mockResolvedValue(undefined);
    await expect(
      service().revokeInvite(membership("MANAGER"), INVITE_ID, "主管"),
    ).resolves.toBeUndefined();
  });

  it("SALES 调撤销返回 403，且不进入内核", async () => {
    const error = await service()
      .revokeInvite(membership("SALES"), INVITE_ID, "销售")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TeamActionError);
    expect((error as TeamActionError).status).toBe(403);
    expect(mocks.revokeMembership).not.toHaveBeenCalled();
  });

  it("membershipId 不是 UUID 时返回 404，不把数据库错误漏成 500", async () => {
    const error = await service()
      .revokeInvite(membership("OWNER"), "not-a-uuid", "老板")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TeamActionError);
    expect((error as TeamActionError).status).toBe(404);
    expect(mocks.revokeMembership).not.toHaveBeenCalled();
  });

  it("内核说「不存在」→ 404", async () => {
    mocks.revokeMembership.mockRejectedValue(
      new KernelError("RESOURCE_NOT_FOUND", "这条邀请不存在或已被撤销"),
    );

    const error = await service()
      .revokeInvite(membership("OWNER"), INVITE_ID, "老板")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TeamActionError);
    expect((error as TeamActionError).status).toBe(404);
    expect((error as TeamActionError).message).not.toMatch(/RESOURCE_NOT_FOUND/);
  });

  it("对方已经接受（ACTIVE）→ 409，说明不能再撤销", async () => {
    mocks.revokeMembership.mockRejectedValue(
      new KernelError("KERNEL_REJECTED", "对方已经接受了邀请，不能再撤销"),
    );

    const error = await service()
      .revokeInvite(membership("OWNER"), INVITE_ID, "老板")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TeamActionError);
    expect((error as TeamActionError).status).toBe(409);
    expect((error as TeamActionError).message).toContain("已经接受");
  });
});
