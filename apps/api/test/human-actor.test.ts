import { describe, expect, it } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { AuthClaims, Membership } from "@weave-order/schema";
import { DEV_HUMAN_CONTEXT, HumanActorService } from "../src/http/human-actor.service";
import type { AuthService } from "../src/gateway/auth.service";
import type { Kernel } from "../src/kernel";

/**
 * HumanActorService 是 HUMAN 写路由唯一的身份来源。
 * 这里不碰数据库：assert 的是「生产态绝不回退占位 OWNER」这条铁律。
 */
const fallbackKernel = { name: "fallback" } as unknown as Kernel;
const scopedKernel = { name: "scoped" } as unknown as Kernel;

function fakeAuth(result?: { claims: AuthClaims; membership: Membership }): AuthService {
  return {
    authenticate: () => {
      if (!result) return Promise.reject(new Error("不应走到认证分支"));
      return Promise.resolve(result);
    },
    openScope: () => Promise.resolve({ kernel: scopedKernel, release: () => Promise.resolve() }),
  } as unknown as AuthService;
}

const claims: AuthClaims = {
  sub: "casdoor-user-1",
  org: "weave",
  name: "真实业务员",
  email: "sales@example.com",
  issuer: "https://sso.example.com",
  audience: "weave-order",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const membership = {
  id: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000002",
  subject: claims.sub,
  casdoorOrg: "weave",
  role: "MANAGER",
  dataScope: "TEAM",
  teamId: null,
  approvalLimitAmount: null,
  status: "ACTIVE",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as Membership;

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    const next = patch[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe("HumanActorService：生产态缺令牌 fail-closed", () => {
  it("NODE_ENV=production 且无令牌 → 401", async () => {
    const service = new HumanActorService(fakeAuth());
    await withEnv({ NODE_ENV: "production", AUTH_MODE: "oidc" }, async () => {
      await expect(
        service.run(undefined, fallbackKernel, () => Promise.resolve("ok")),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  it("AUTH_MODE=oidc 的 staging（NODE_ENV=development）同样 401，不回退 OWNER", async () => {
    const service = new HumanActorService(fakeAuth());
    await withEnv({ NODE_ENV: "development", AUTH_MODE: "oidc" }, async () => {
      await expect(
        service.run(undefined, fallbackKernel, () => Promise.resolve("ok")),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  it("本地 dev 无令牌才回退 DEV_HUMAN_CONTEXT", async () => {
    const service = new HumanActorService(fakeAuth());
    await withEnv({ NODE_ENV: "development", AUTH_MODE: "dev" }, async () => {
      const ctx = await service.run(undefined, fallbackKernel, (kernel, context) => {
        expect(kernel).toBe(fallbackKernel);
        return Promise.resolve(context);
      });
      expect(ctx.actor).toEqual(DEV_HUMAN_CONTEXT.actor);
    });
  });
});

describe("HumanActorService：有令牌时注入真实角色与租户作用域", () => {
  it("membership.role 进入 KernelContext，而非固定 OWNER", async () => {
    const service = new HumanActorService(fakeAuth({ claims, membership }));
    const result = await service.run("Bearer token", fallbackKernel, (kernel, ctx) =>
      Promise.resolve({ kernel, ctx }),
    );
    expect(result.kernel).toBe(scopedKernel);
    expect(result.ctx.actor).toEqual({
      type: "HUMAN",
      id: claims.sub,
      role: "MANAGER",
      approvalLimitAmount: null,
    });
  });

  it("membership.approvalLimitAmount 注入 KernelContext，供内核判定成员额度", async () => {
    const service = new HumanActorService(
      fakeAuth({
        claims,
        membership: { ...membership, role: "SALES", approvalLimitAmount: 5000 },
      }),
    );
    const result = await service.run("Bearer token", fallbackKernel, (kernel, ctx) =>
      Promise.resolve(ctx),
    );
    expect(result.actor).toEqual({
      type: "HUMAN",
      id: claims.sub,
      role: "SALES",
      approvalLimitAmount: 5000,
    });
  });

  it("成员身份未启用 → 403", async () => {
    const service = new HumanActorService(
      fakeAuth({ claims, membership: { ...membership, status: "DISABLED" } }),
    );
    await expect(
      service.run("Bearer token", fallbackKernel, () => Promise.resolve("ok")),
    ).rejects.toMatchObject({ status: 403 });
  });
});
