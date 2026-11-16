import { HttpException } from "@nestjs/common";
import type { AuthClaims, OnboardingResult } from "@weave-order/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../src/gateway/auth.service";
import { OnboardingController, TeamController } from "../src/onboarding/onboarding.controller";
import { TeamActionError } from "../src/onboarding/onboarding.service";
import type { OnboardingService } from "../src/onboarding/onboarding.service";
import { TENANT_START_RATE_LIMITS, PublicRateLimitService } from "../src/platform/rate-limit";

vi.mock("../src/gateway/auth.service", () => ({ AuthService: class {} }));
vi.mock("../src/onboarding/onboarding.service", () => ({
  OnboardingService: class {},
  StartTenantConflict: class extends Error {},
  TeamActionError: class TeamActionError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = "TeamActionError";
    }
  },
}));
vi.mock("../src/kernel", () => ({ isKernelError: () => false }));

const claims: AuthClaims = {
  sub: "new-owner",
  org: "weave-order",
  name: "新老板",
  email: "owner@example.com",
  issuer: "https://sso.example.test",
  audience: "weave-order",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const result: OnboardingResult = {
  tenantId: "tenant-1",
  tenantSlug: "tenant-one",
  tenantName: "测试公司",
  membershipId: "membership-1",
  role: "OWNER",
  dataScope: "ALL",
  alreadyActivated: false,
};

const limiters: PublicRateLimitService[] = [];

function setup() {
  const auth = {
    verifyClaims: vi.fn().mockResolvedValue(claims),
  } as unknown as AuthService;
  const start = vi.fn().mockResolvedValue(result);
  const onboarding = { start } as unknown as OnboardingService;
  const limiter = new PublicRateLimitService("onboarding-controller-test", null);
  limiters.push(limiter);
  const controller = new OnboardingController(auth, onboarding, limiter);
  return { controller, start, limiter };
}

afterEach(() => {
  for (const limiter of limiters.splice(0)) limiter.onApplicationShutdown();
});

describe("自助创建公司控制器", () => {
  it("同一账号超过阈值时返回统一 429，且不再进入创建公司业务", async () => {
    const { controller, start } = setup();

    for (let index = 0; index < TENANT_START_RATE_LIMITS.sub.limit; index += 1) {
      await expect(
        controller.start("Bearer token", { name: "测试公司" }, `198.51.100.${index}`, undefined),
      ).resolves.toEqual(result);
    }

    const error = await controller
      .start("Bearer token", { name: "测试公司" }, "198.51.100.250", undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    const body: unknown = (error as HttpException).getResponse();
    expect(body).toMatchObject({ error: { code: "RATE_LIMITED" } });
    const retryAfterSeconds = (body as { error: { details: { retryAfterSeconds: unknown } } }).error
      .details.retryAfterSeconds;
    expect(typeof retryAfterSeconds).toBe("number");
    expect(start).toHaveBeenCalledTimes(TENANT_START_RATE_LIMITS.sub.limit);
  });

  it("限流使用 XFF 第一跳和已验证的 Casdoor sub", async () => {
    const { controller, limiter } = setup();
    const check = vi.spyOn(limiter, "checkTenantStart");

    await controller.start(
      "Bearer token",
      { name: "测试公司" },
      "127.0.0.1",
      "203.0.113.99, 10.0.0.1",
    );

    expect(check).toHaveBeenCalledWith("203.0.113.99", claims.sub);
  });
});

describe("撤销邀请控制器", () => {
  const member = {
    id: "membership-owner",
    tenantId: "tenant-1",
    subject: "boss@example.com",
    casdoorOrg: null,
    role: "OWNER" as const,
    dataScope: "ALL" as const,
    teamId: null,
    approvalLimitAmount: null,
    status: "ACTIVE" as const,
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
  };

  function setupTeam(role: "OWNER" | "SALES") {
    const auth = {
      authenticate: vi.fn().mockResolvedValue({
        claims,
        membership: { ...member, role },
      }),
    } as unknown as AuthService;
    const revokeInvite = vi.fn();
    const onboarding = { revokeInvite } as unknown as OnboardingService;
    return { controller: new TeamController(auth, onboarding), revokeInvite };
  }

  it("老板撤销成功返回统一 ok", async () => {
    const { controller, revokeInvite } = setupTeam("OWNER");
    revokeInvite.mockResolvedValue(undefined);

    await expect(controller.revoke("Bearer token", "invite-1")).resolves.toEqual({ ok: true });
    expect(revokeInvite).toHaveBeenCalledWith(
      expect.objectContaining({ role: "OWNER", tenantId: "tenant-1" }),
      "invite-1",
      claims.name,
    );
  });

  it("SALES 调 DELETE 返回 403，不落成 500", async () => {
    const { controller, revokeInvite } = setupTeam("SALES");
    revokeInvite.mockRejectedValue(new TeamActionError("只有老板或主管可以撤销邀请", 403));

    const error = await controller
      .revoke("Bearer token", "invite-1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(403);
    expect((error as HttpException).getResponse()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });
});
