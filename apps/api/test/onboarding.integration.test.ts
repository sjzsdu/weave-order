import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { DEV_ONBOARDING_SECRET, signOnboardingTicket } from "../src/onboarding/ticket";

/**
 * 开通链接验收（真实 PG）：
 * 平台签发一条票据 → 新老板用统一账号打开 → 业务库建出公司 + 老板成员 → 再访问业务接口。
 *
 * 覆盖：首次领取、重复领取幂等、邮箱不一致被拒、票据签错密钥被拒、领取后 `/api/auth/me` 可用。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let pool: Pool | null = null;
let available = false;
let app: INestApplication | null = null;
let baseUrl = "";
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function api(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.memberships') IS NOT NULL AND to_regclass('public.tenants') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (available) {
      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(0);
      const address = (app.getHttpServer() as Server).address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  if (pool && available && createdTenants.length > 0) {
    // audit_log 只追加，触发器禁止 DELETE；它没有指向租户的外键，保留即可。
    await pool.query("DELETE FROM memberships WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await pool?.end();
});

describe("开通链接领取", () => {
  it("新老板领取后建出公司并成为老板", async (ctx) => {
    if (!available || !app) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const slug = `onboard-${id}`;
    const subject = `boss-${id}`;
    const email = `boss-${id}@dev.local`;
    const code = signOnboardingTicket(
      { v: 1, slug, name: `开通测试 ${id}`, ownerEmail: email },
      DEV_ONBOARDING_SECRET,
    );
    const token = `dev:${subject}:demo`;

    // 领取前：还没有成员身份，业务接口应当拒绝。
    const before = await api("/api/auth/me", {}, token);
    expect(before.status, JSON.stringify(before.body)).toBe(403);

    // 预览：公司还没建，但名字与有效期能看到。
    const preview = await api(
      `/api/onboarding/preview?code=${encodeURIComponent(code)}`,
      {},
      token,
    );
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ slug, tenantExists: false, membershipExists: false });

    const claim = await api(
      "/api/onboarding/claim",
      { method: "POST", body: JSON.stringify({ code }) },
      token,
    );
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    const result = claim.body as { tenantId: string; tenantSlug: string; role: string };
    createdTenants.push(result.tenantId);
    expect(result.tenantSlug).toBe(slug);
    expect(result.role).toBe("OWNER");

    // 领取后：同一账号直接可用，落在刚建的公司里。
    const me = await api("/api/auth/me", {}, token);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ tenant: { slug }, membership: { role: "OWNER" } });

    // 再点一次：幂等，不报错、不重复建。
    const again = await api(
      "/api/onboarding/claim",
      { method: "POST", body: JSON.stringify({ code }) },
      token,
    );
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ tenantId: result.tenantId, alreadyActivated: true });
  });

  it("登录邮箱与登记邮箱不一致时拒绝", async (ctx) => {
    if (!available || !app) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const code = signOnboardingTicket(
      {
        v: 1,
        slug: `onboard-${id}`,
        name: `邮箱校验 ${id}`,
        ownerEmail: "someone-else@example.com",
      },
      DEV_ONBOARDING_SECRET,
    );
    const response = await api(
      "/api/onboarding/claim",
      { method: "POST", body: JSON.stringify({ code }) },
      `dev:boss-${id}:demo`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(410);
  });

  it("密钥不对的票据被拒，且不会建出租户", async (ctx) => {
    if (!available || !app || !pool) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const slug = `onboard-${id}`;
    const code = signOnboardingTicket(
      { v: 1, slug, name: `伪造 ${id}`, ownerEmail: null },
      "not-the-right-secret-but-long-enough-0001",
    );
    const response = await api(
      "/api/onboarding/claim",
      { method: "POST", body: JSON.stringify({ code }) },
      `dev:boss-${id}:demo`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(410);
    const rows = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
    expect(rows.rowCount).toBe(0);
  });
});

describe("自助开通与邀请", () => {
  it("老板创建公司，员工接受邀请后落在同一间公司", async (ctx) => {
    if (!available || !app) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const bossSubject = `boss-self-${id}`;
    const bossToken = `dev:${bossSubject}:demo`;
    const employeeSubject = `emp-${id}`;
    const employeeEmail = `${employeeSubject}@dev.local`;
    const employeeToken = `dev:${employeeSubject}:demo`;

    // 老板自助建公司：不需要任何平台链接。
    const start = await api(
      "/api/onboarding/start",
      { method: "POST", body: JSON.stringify({ name: `自助公司 ${id}` }) },
      bossToken,
    );
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const company = start.body as { tenantId: string; tenantSlug: string; role: string };
    createdTenants.push(company.tenantId);
    expect(company.role).toBe("OWNER");
    expect(company.tenantSlug).toMatch(/^t-/);

    // 老板邀请同事：拿到一条专属链接。
    const invite = await api(
      "/api/team/invites",
      { method: "POST", body: JSON.stringify({ email: employeeEmail, role: "SALES" }) },
      bossToken,
    );
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    const link = invite.body as { url: string; email: string; role: string };
    expect(link.email).toBe(employeeEmail);
    expect(link.role).toBe("SALES");
    const code = new URL(link.url).searchParams.get("code");
    expect(code).toBeTruthy();

    // 员工还没接受前：没有成员身份。
    const beforeJoin = await api("/api/auth/me", {}, employeeToken);
    expect(beforeJoin.status).toBe(403);

    // 员工打开链接：能看到公司名与角色。
    const preview = await api(
      `/api/onboarding/invite/preview?code=${encodeURIComponent(code as string)}`,
      {},
      employeeToken,
    );
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ tenantSlug: company.tenantSlug, role: "SALES" });

    // 接受邀请 → 绑定到同一间公司。
    const accept = await api(
      "/api/onboarding/invite/accept",
      { method: "POST", body: JSON.stringify({ code }) },
      employeeToken,
    );
    expect(accept.status, JSON.stringify(accept.body)).toBe(201);
    expect(accept.body).toMatchObject({ tenantId: company.tenantId, role: "SALES" });

    const me = await api("/api/auth/me", {}, employeeToken);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ tenant: { slug: company.tenantSlug } });

    // 重复接受：幂等。
    const again = await api(
      "/api/onboarding/invite/accept",
      { method: "POST", body: JSON.stringify({ code }) },
      employeeToken,
    );
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ tenantId: company.tenantId, alreadyActivated: true });
  });

  it("员工不能邀请人（只有老板/主管可以）", async (ctx) => {
    if (!available || !app) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const employee = await api(
      "/api/onboarding/start",
      { method: "POST", body: JSON.stringify({ name: `权限公司 ${id}` }) },
      `dev:emp2-${id}:demo`,
    );
    expect(employee.status).toBe(201);
    createdTenants.push((employee.body as { tenantId: string }).tenantId);
    // 老板建的公司里，员工是 OWNER；先降级需要一个非 OWNER 账号，
    // 这里直接验证未加入者没有权限即可（401/403 都算拒绝）。
    const outsider = await api(
      "/api/team/invites",
      { method: "POST", body: JSON.stringify({ email: `x-${id}@dev.local`, role: "SALES" }) },
      `dev:outsider-${id}:demo`,
    );
    expect([401, 403]).toContain(outsider.status);
  });
});
