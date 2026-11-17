import { describe, expect, it } from "vitest";
import { AuthClaims } from "@weave-order/schema";
import type { Membership, Tenant, TenantChoice } from "@weave-order/schema";
import type { Pool } from "pg";
import { KernelError } from "../src/kernel";
import type { Kernel } from "../src/kernel";
import { AuthError } from "../src/auth/errors";
import { AuthService } from "../src/gateway/auth.service";
import { MemorySessionStore, SessionService } from "../src/gateway/session.service";
import {
  readSessionCookie,
  SessionCredentialMiddleware,
} from "../src/gateway/session-credential.middleware";

const NOW = "2026-01-01T00:00:00.000Z";
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const TENANT_C = "33333333-3333-4333-8333-333333333333";

function tenant(id: string, name: string): Tenant {
  return {
    id,
    slug: `t-${id.slice(0, 3)}`,
    name,
    brand: null,
    bank: null,
    currency: "CNY",
    settings: {},
    status: "ACTIVE",
    isolationMode: "SHARED_RLS",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function membership(props: {
  id: string;
  tenantId: string;
  subject: string;
  role?: Membership["role"];
  status?: Membership["status"];
  casdoorOrg?: string | null;
}): Membership {
  return {
    id: props.id,
    tenantId: props.tenantId,
    subject: props.subject,
    casdoorOrg: props.casdoorOrg ?? null,
    role: props.role ?? "SALES",
    dataScope: "ALL",
    teamId: null,
    approvalLimitAmount: null,
    status: props.status ?? "ACTIVE",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function claims(subject: string, org: string | null = null): AuthClaims {
  return AuthClaims.parse({
    sub: subject,
    org,
    name: "测试成员",
    email: "tester@example.com",
    issuer: "test",
    audience: "test",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  });
}

/**
 * 目录替身：只实现 AuthService 用到的那几个方法。
 * 这里刻意不碰数据库，让租户选择的状态机可以纯逻辑验证。
 */
function directoryWith(input: {
  memberships: Membership[];
  tenants: Tenant[];
  audits?: Array<Record<string, unknown>>;
}): Kernel {
  const active = (subject: string) =>
    input.memberships.filter((row) => row.subject === subject && row.status === "ACTIVE");
  return {
    tenancy: {
      listTenantChoices(subject: string): Promise<TenantChoice[]> {
        return Promise.resolve(
          input.memberships
            .filter((row) => row.subject === subject && row.status !== "INVITED")
            .map((row) => {
              const owner = input.tenants.find((entry) => entry.id === row.tenantId);
              if (!owner) throw new Error("租户缺失");
              return {
                tenantId: owner.id,
                slug: owner.slug,
                name: owner.name,
                brand: owner.brand,
                role: row.status === "ACTIVE" ? row.role : null,
                tenantStatus: owner.status,
                membershipStatus: row.status,
                available: row.status === "ACTIVE" && owner.status !== "CLOSED",
              };
            }),
        );
      },
      resolveMembership(subject: string, tenantId: string): Promise<Membership> {
        const found = active(subject).find((row) => row.tenantId === tenantId);
        if (!found) {
          return Promise.reject(
            new KernelError("PERMISSION_DENIED", "该账号没有这个租户的可用成员身份"),
          );
        }
        return Promise.resolve(found);
      },
      resolveSoleMembership(subject: string, org: string | null): Promise<Membership> {
        const rows = active(subject);
        const sole = rows[0];
        if (!sole || rows.length > 1) {
          return Promise.reject(new KernelError("PERMISSION_DENIED", "租户不可用"));
        }
        if (org !== null && sole.casdoorOrg !== null && sole.casdoorOrg !== org) {
          return Promise.reject(
            new KernelError("PERMISSION_DENIED", "令牌组织与本地成员记录不一致"),
          );
        }
        return Promise.resolve(sole);
      },
      getTenant(id: string): Promise<Tenant> {
        const found = input.tenants.find((entry) => entry.id === id);
        if (!found) return Promise.reject(new Error("租户不存在"));
        return Promise.resolve(found);
      },
      recordTenantSwitch(entry: Record<string, unknown>): Promise<void> {
        input.audits?.push(entry);
        return Promise.resolve();
      },
    },
  } as unknown as Kernel;
}

function build(input: {
  memberships: Membership[];
  tenants: Tenant[];
  audiences?: { session: "multi" | "tenantId"; tenantId?: string };
  verifier?: (token: string) => Promise<AuthClaims>;
}) {
  const audits: Array<Record<string, unknown>> = [];
  const sessions = new SessionService(new MemorySessionStore(), 3600);
  const service = new AuthService(
    {} as Pool,
    {
      verify: input.verifier ?? ((token: string) => Promise.resolve(claims(token))),
    },
    directoryWith({ memberships: input.memberships, tenants: input.tenants, audits }),
    // PAT 在本文件里不是主角：返回 null 走「凭据无效」分支即可。
    { verify: () => Promise.resolve(null) } as never,
    sessions,
  );
  return { service, sessions, audits };
}

const A = tenant(TENANT_A, "华东纺织");
const B = tenant(TENANT_B, "华南服饰");
const C = tenant(TENANT_C, "已关闭的公司");
const CLOSED_C = { ...C, status: "CLOSED" as const };

describe("租户会话与选择（单元）", () => {
  it("多租户账号首次 /me：返回选择列表并签发未绑定会话", async () => {
    const { service, sessions } = build({
      tenants: [A, B],
      memberships: [
        membership({
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          tenantId: TENANT_A,
          subject: "sub-1",
          role: "SALES",
        }),
        membership({
          id: "bbbbbbbb-1111-4111-8111-111111111111",
          tenantId: TENANT_B,
          subject: "sub-1",
          role: "FINANCE",
        }),
      ],
    });

    const result = await service.me("Bearer sub-1", null);
    expect(result.sid).toBeTruthy();
    if (!("tenants" in result.body)) throw new Error("应当返回选择列表");
    expect(result.body.status).toBe("MULTI_TENANT");
    expect(result.body.tenants.map((entry) => entry.role).sort()).toEqual(["FINANCE", "SALES"]);

    const record = await sessions.read(result.sid);
    expect(record?.tenantId).toBeNull();
    expect(record?.sub).toBe("sub-1");
  });

  it("verifyClaims 接受会话凭据：不再把 session:<sid> 丢给 OIDC 验签器", async () => {
    let verifierCalls = 0;
    const { service, sessions } = build({
      tenants: [A],
      memberships: [
        membership({
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          tenantId: TENANT_A,
          subject: "sub-verify",
          role: "OWNER",
        }),
      ],
      verifier: () => {
        verifierCalls += 1;
        return Promise.reject(new Error("Invalid Compact JWS"));
      },
    });
    const { sid } = await sessions.create({
      sub: "sub-verify",
      name: "老板",
      email: "boss@example.com",
      tenantId: TENANT_A,
    });

    // 网关中间件把 Cookie 归一成 `Bearer session:<sid>`；开通/邀请预览直接用它。
    const claims = await service.verifyClaims(`Bearer session:${sid}`);
    expect(claims.sub).toBe("sub-verify");
    expect(claims.email).toBe("boss@example.com");
    expect(verifierCalls).toBe(0);
  });

  it("verifyClaims 对失效会话给可读错误，而不是 jose 的技术串", async () => {
    const { service } = build({ tenants: [A], memberships: [] });
    await expect(service.verifyClaims("Bearer session:not-a-real-sid")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("选择租户后换一把 sid，旧 sid 立刻失效", async () => {
    const { service, sessions, audits } = build({
      tenants: [A, B],
      memberships: [
        membership({
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          tenantId: TENANT_A,
          subject: "sub-1",
        }),
        membership({
          id: "bbbbbbbb-1111-4111-8111-111111111111",
          tenantId: TENANT_B,
          subject: "sub-1",
        }),
      ],
    });
    const first = await service.me("Bearer sub-1", null);
    const oldSid = first.sid as string;

    const picked = await service.switchTenant(`Bearer session:${oldSid}`, oldSid, {
      tenantId: TENANT_A,
    });
    expect(picked.body.tenant.id).toBe(TENANT_A);
    expect(picked.sid).not.toBe(oldSid);
    expect(await sessions.read(oldSid)).toBeNull();
    expect((await sessions.read(picked.sid))?.tenantId).toBe(TENANT_A);

    // 审计落在目标租户，且带 from / to。
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      toTenantId: TENANT_A,
      fromTenantId: null,
      result: "ALLOWED",
      subject: "sub-1",
    });
  });

  it("已绑定的会话切换：from 记录当前租户，业务鉴权拿到新租户的 membership", async () => {
    const { service } = build({
      tenants: [A, B],
      memberships: [
        membership({
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          tenantId: TENANT_A,
          subject: "sub-1",
          role: "SALES",
        }),
        membership({
          id: "bbbbbbbb-1111-4111-8111-111111111111",
          tenantId: TENANT_B,
          subject: "sub-1",
          role: "FINANCE",
        }),
      ],
    });
    const bound = await service.switchTenant("Bearer sub-1", null, { tenantId: TENANT_A });
    const identity = await service.authenticate(`Bearer session:${bound.sid}`);
    expect(identity.membership.tenantId).toBe(TENANT_A);
    expect(identity.membership.role).toBe("SALES");

    const moved = await service.switchTenant(`Bearer session:${bound.sid}`, bound.sid, {
      tenantId: TENANT_B,
    });
    const movedIdentity = await service.authenticate(`Bearer session:${moved.sid}`);
    expect(movedIdentity.membership.role).toBe("FINANCE");
  });

  it("未选租户的会话访问业务接口 → TENANT_REQUIRED（403）", async () => {
    const { service, sessions } = build({
      tenants: [A, B],
      memberships: [
        membership({
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          tenantId: TENANT_A,
          subject: "sub-1",
        }),
        membership({
          id: "bbbbbbbb-1111-4111-8111-111111111111",
          tenantId: TENANT_B,
          subject: "sub-1",
        }),
      ],
    });
    const created = await sessions.create({
      sub: "sub-1",
      name: null,
      email: null,
      tenantId: null,
    });
    await expect(service.authenticate(`Bearer session:${created.sid}`)).rejects.toMatchObject({
      code: "TENANT_REQUIRED",
      status: 403,
    });
  });

  it("切换到自己没有的租户 → TENANT_UNAVAILABLE，并落一条拒绝审计", async () => {
    const { service, audits } = build({
      tenants: [A, B],
      memberships: [
        membership({
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          tenantId: TENANT_A,
          subject: "sub-1",
        }),
      ],
    });
    const bound = await service.switchTenant("Bearer sub-1", null, { tenantId: TENANT_A });
    audits.length = 0;
    await expect(
      service.switchTenant(`Bearer session:${bound.sid}`, bound.sid, { tenantId: TENANT_B }),
    ).rejects.toMatchObject({ code: "TENANT_UNAVAILABLE" });
    expect(audits[0]).toMatchObject({
      result: "DENIED",
      fromTenantId: TENANT_A,
      toTenantId: TENANT_B,
    });
  });

  it("PAT 不能切换租户（agent 不跟着人切）", async () => {
    const { service } = build({ tenants: [A], memberships: [] });
    await expect(
      service.switchTenant("Bearer wo_abcdefghij_" + "a".repeat(32), null, { tenantId: TENANT_A }),
    ).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  it("零成员关系 → NO_MEMBERSHIP；只有停用成员关系时可见不可进", async () => {
    const none = build({ tenants: [A], memberships: [] });
    await expect(none.service.me("Bearer sub-none", null)).rejects.toMatchObject({
      code: "NO_MEMBERSHIP",
    });

    const disabled = build({
      tenants: [A],
      memberships: [
        membership({
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          tenantId: TENANT_A,
          subject: "sub-disabled",
          status: "DISABLED",
        }),
      ],
    });
    const result = await disabled.service.me("Bearer sub-disabled", null);
    if (!("tenants" in result.body)) throw new Error("应当返回选择列表");
    expect(result.body.tenants[0]?.available).toBe(false);
    expect(result.body.tenants[0]?.role).toBeNull();
  });

  it("关闭的租户可见但不可进入", async () => {
    const { service } = build({
      tenants: [CLOSED_C],
      memberships: [
        membership({
          id: "cccccccc-1111-4111-8111-111111111111",
          tenantId: TENANT_C,
          subject: "sub-c",
        }),
      ],
    });
    const result = await service.me("Bearer sub-c", null);
    if (!("tenants" in result.body)) throw new Error("应当返回选择列表");
    expect(result.body.tenants[0]?.available).toBe(false);
  });

  it("单租户账号自动绑定（org 不一致拒绝），不出现选择页", async () => {
    const { service } = build({
      tenants: [A],
      memberships: [
        membership({
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          tenantId: TENANT_A,
          subject: "sub-a",
          casdoorOrg: "org-a",
        }),
      ],
      verifier: (token) => Promise.resolve(claims("sub-a", token === "good" ? "org-a" : "org-x")),
    });
    const ok = await service.me("Bearer good", null);
    expect("tenants" in ok.body).toBe(false);
    if ("tenants" in ok.body) throw new Error("单租户不应出现选择页");
    expect(ok.body.tenant.id).toBe(TENANT_A);

    await expect(service.me("Bearer bad", null)).rejects.toBeInstanceOf(Error);
  });

  it("绑定租户被收回后 /me 回到选择页并换新会话", async () => {
    const memberships = [
      membership({
        id: "aaaaaaaa-1111-4111-8111-111111111111",
        tenantId: TENANT_A,
        subject: "sub-1",
      }),
      membership({
        id: "bbbbbbbb-1111-4111-8111-111111111111",
        tenantId: TENANT_B,
        subject: "sub-1",
      }),
    ];
    const { service, sessions } = build({ tenants: [A, B], memberships });
    const bound = await service.switchTenant("Bearer sub-1", null, { tenantId: TENANT_A });

    // 模拟管理员收回了 A 的权限。
    memberships[0]!.status = "DISABLED";
    const result = await service.me(`Bearer session:${bound.sid}`, bound.sid);
    if (!("tenants" in result.body)) throw new Error("应当回到选择页");
    expect(result.body.tenants.find((entry) => entry.tenantId === TENANT_A)?.available).toBe(false);
    expect(result.sid).not.toBe(bound.sid);
    expect(await sessions.read(bound.sid)).toBeNull();
  });

  it("登出吊销会话；未知 sid 按未认证处理", async () => {
    const { service, sessions } = build({
      tenants: [A],
      memberships: [
        membership({
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          tenantId: TENANT_A,
          subject: "sub-a",
        }),
      ],
    });
    const { sid } = await sessions.create({
      sub: "sub-a",
      name: null,
      email: null,
      tenantId: TENANT_A,
    });
    await service.logout(`Bearer session:${sid}`, sid);
    expect(await sessions.read(sid)).toBeNull();
    await expect(service.authenticate(`Bearer session:${sid}`)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await expect(service.authenticate("Bearer session:not-a-real-sid")).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

describe("会话 Cookie 与凭据优先级（中间件）", () => {
  it("有 sid 时归一成 session 凭据；PAT 优先于浏览器会话", async () => {
    const middleware = new SessionCredentialMiddleware();
    const fromCookie: { headers: { cookie?: string; authorization?: string } } = {
      headers: { cookie: "other=1; weave_sid=abc123" },
    };
    await middleware.use(fromCookie, {}, () => undefined);
    expect(fromCookie.headers.authorization).toBe("Bearer session:abc123");

    const pat: { headers: { cookie?: string; authorization?: string } } = {
      headers: {
        cookie: "weave_sid=abc123",
        authorization: "Bearer wo_abcdefghij_" + "a".repeat(32),
      },
    };
    await middleware.use(pat, {}, () => undefined);
    expect(pat.headers.authorization).toMatch(/^Bearer wo_/);

    const none: { headers: { cookie?: string; authorization?: string } } = { headers: {} };
    await middleware.use(none, {}, () => undefined);
    expect(none.headers.authorization).toBeUndefined();
  });

  /**
   * dev 会话在进程内，API 重启后就丢了；此时浏览器里的旧 sid 不能盖掉
   * BFF 注入的 dev 兜底令牌，否则「免登录」会变成「会话已过期」。
   */
  it("dev 态会话已失效时保留兜底令牌；有效会话仍然优先", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAuthMode = process.env.AUTH_MODE;
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "dev";
    try {
      const sessions = new SessionService(new MemorySessionStore(), 60);
      const middleware = new SessionCredentialMiddleware(sessions);

      const stale: { headers: { cookie?: string; authorization?: string } } = {
        headers: { cookie: "weave_sid=restarted", authorization: "Bearer dev:demo:demo" },
      };
      await middleware.use(stale, {}, () => undefined);
      expect(stale.headers.authorization).toBe("Bearer dev:demo:demo");

      const { sid } = await sessions.create({
        sub: "demo",
        name: null,
        email: null,
        tenantId: TENANT_A,
      });
      const valid: { headers: { cookie?: string; authorization?: string } } = {
        headers: { cookie: `weave_sid=${sid}`, authorization: "Bearer dev:demo:demo" },
      };
      await middleware.use(valid, {}, () => undefined);
      expect(valid.headers.authorization).toBe(`Bearer session:${sid}`);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousAuthMode;
    }
  });

  it("Cookie 解析只认 weave_sid，忽略其它值", () => {
    expect(readSessionCookie("a=b; weave_sid=xyz")).toBe("xyz");
    expect(readSessionCookie("weave_sid=")).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });
});
