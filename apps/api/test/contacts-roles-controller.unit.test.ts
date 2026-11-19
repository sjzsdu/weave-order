import { UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { Kernel } from "../src/kernel";
import type { AuthService } from "../src/gateway/auth.service";
import { ContactsController } from "../src/http/controllers";
import { HumanActorService } from "../src/http/human-actor.service";

/**
 * `GET /api/contacts/roles` 必须在登录态下才能读：
 * 生产环境无令牌 → 401，绝不能用默认内核把别家公司的角色选项借出来。
 */
const roles = { roles: [{ code: "ROLE-PURCHASING", label: "采购" }] };

function fakeAuth(): AuthService {
  return {
    authenticate: () => Promise.reject(new Error("未提供令牌时不应走到认证")),
    openScope: () => Promise.resolve({ kernel, release: () => Promise.resolve() }),
  } as unknown as AuthService;
}

const roleOptions = vi.fn().mockResolvedValue(roles);
const kernel = { contacts: { roleOptions } } as unknown as Kernel;

function controller(): ContactsController {
  return new ContactsController(kernel, new HumanActorService(fakeAuth()));
}

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    const next = patch[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("ContactsController.roles 鉴权", () => {
  it("生产环境无令牌 → 401，且不读默认内核", async () => {
    roleOptions.mockClear();
    await withEnv({ NODE_ENV: "production", AUTH_MODE: "oidc" }, async () => {
      await expect(controller().roles(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    });
    expect(roleOptions).not.toHaveBeenCalled();
  });

  it("本地 dev 无令牌回退到演示上下文，仍返回角色选项", async () => {
    await withEnv({ NODE_ENV: "development", AUTH_MODE: "dev" }, async () => {
      await expect(controller().roles(undefined)).resolves.toEqual(roles);
    });
  });
});
