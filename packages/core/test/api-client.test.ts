import { describe, expect, it, vi } from "vitest";
import { roleCapabilities } from "@weave-order/schema";
import { ApiError, createApiClient } from "../src/api-client";

const CUSTOMER = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  tenantId: "00000000-0000-0000-0000-000000000001",
  code: "C001",
  name: "杭州织造",
  tier: "VIP",
  status: "AVAILABLE",
  contactName: null,
  contactPhone: null,
  contactEmail: null,
};

const SAMPLE = {
  id: "123e4567-e89b-12d3-a456-426614174002",
  tenantId: "00000000-0000-0000-0000-000000000001",
  code: "S001",
  name: "全棉府绸",
  composition: "100% 棉",
  category: "针织",
  weight: "220g/m²",
  unit: "meter",
  costFloor: null,
  status: "ACTIVE",
  primaryImageUrl: null,
  createdAt: "2026-11-20T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("API client（契约解析 + 令牌）", () => {
  it("带上 Bearer 令牌并解析客户列表", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ customers: [CUSTOMER] })),
    );
    const client = createApiClient({
      baseUrl: "http://api.test/",
      getToken: () => "dev:alice:acme",
      fetchImpl,
    });

    const customers = await client.listCustomers(5);
    expect(customers).toHaveLength(1);
    expect(customers[0]?.name).toBe("杭州织造");

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://api.test/api/customers?limit=5");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer dev:alice:acme");
  });

  it("契约不符时抛出 ZodError（不把脏数据带进页面）", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl: () => Promise.resolve(jsonResponse({ customers: [{ id: "not-a-uuid" }] })),
    });
    await expect(client.listCustomers()).rejects.toThrow();
  });

  it("样品筛选透传成分与克重档位，并解析档位选项", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({
          samples: [],
          nextCursor: null,
          hasMore: false,
          total: 0,
          remaining: 0,
          categories: ["针织"],
          compositions: ["100% 棉"],
          weights: ["220g/m²", "320g/m²"],
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl,
    });

    const page = await client.listSamplesPage({
      composition: "棉",
      weights: ["220g/m²", "320g/m²"],
      status: "ACTIVE",
    });
    expect(page.compositions).toEqual(["100% 棉"]);
    expect(page.weights).toEqual(["220g/m²", "320g/m²"]);

    const [url] = fetchImpl.mock.calls[0] ?? [];
    const params = new URL(url as string).searchParams;
    expect(params.get("composition")).toBe("棉");
    expect(params.get("weights")).toBe("220g/m²,320g/m²");
    expect(params.get("status")).toBe("ACTIVE");
  });

  it("样品列表容忍分页元数据（WAN-201：真实端点总带 nextCursor/total）", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse({
            samples: [SAMPLE],
            nextCursor: "cursor-2",
            hasMore: true,
            total: 6,
            remaining: 5,
            categories: ["针织"],
            compositions: ["100% 棉"],
            weights: ["220g/m²"],
          }),
        ),
    });

    const samples = await client.listSamples(50);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.code).toBe("S001");
  });

  it("样品列表仍兼容只回 samples 的旧实现/移动端 mock", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl: () => Promise.resolve(jsonResponse({ samples: [SAMPLE] })),
    });

    await expect(client.listSamples()).resolves.toHaveLength(1);
  });

  it("错误响应映射成 ApiError(code/message)", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse({ error: { code: "UNAUTHENTICATED", message: "缺少 Bearer 令牌" } }, 401),
        ),
    });
    await expect(client.me()).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "UNAUTHENTICATED",
    });
    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
  });

  it("生成报价草稿不会替服务端计算金额", async () => {
    const body = {
      ok: true,
      data: {
        draft: {
          id: "123e4567-e89b-12d3-a456-426614174001",
          tenantId: "00000000-0000-0000-0000-000000000001",
          customerId: CUSTOMER.id,
          status: "DRAFT",
          currency: "CNY",
          items: [
            {
              fabricSampleId: "123e4567-e89b-12d3-a456-426614174002",
              description: "全棉府绸",
              quantity: { value: 10, unit: "meter" },
              unitPrice: { amount: 1500, currency: "CNY" },
              lineTotal: { amount: 15000, currency: "CNY" },
            },
          ],
          subtotal: { amount: 15000, currency: "CNY" },
          total: { amount: 15000, currency: "CNY" },
          amountsComputedByKernel: true,
          validityDays: 30,
          expiresAt: "2026-12-12T00:00:00.000Z",
          createdAt: "2026-11-12T00:00:00.000Z",
          remarks: null,
        },
      },
    };
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => "t",
      fetchImpl: () => Promise.resolve(jsonResponse(body)),
    });
    const result = await client.generateQuoteDraft({
      customerId: CUSTOMER.id,
      currency: "CNY",
      items: [
        {
          fabricSampleId: "123e4567-e89b-12d3-a456-426614174002",
          quantity: { value: 10, unit: "meter" },
          unitPrice: { amount: 1500, currency: "CNY" },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.draft.total.amount).toBe(15000);
  });
});

describe("API client（租户选择）", () => {
  const TENANT_A = {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "acme",
    name: "华东纺织",
    brand: null,
    bank: null,
    currency: "CNY",
    settings: {},
    status: "ACTIVE",
    isolationMode: "SHARED_RLS",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("/me 的 MULTI_TENANT 分支被识别为待选择，而不是当作上下文解析失败", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse({
            status: "MULTI_TENANT",
            subject: "sub-1",
            name: null,
            email: null,
            tenants: [
              {
                tenantId: TENANT_A.id,
                slug: "acme",
                name: "华东纺织",
                brand: null,
                role: "SALES",
                tenantStatus: "ACTIVE",
                membershipStatus: "ACTIVE",
                available: true,
              },
            ],
          }),
        ),
    });
    const me = await client.me();
    expect("tenants" in me).toBe(true);
  });

  it("switchTenant 只在请求体里传 tenantId，并解析绑定上下文", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({
          subject: "sub-1",
          name: null,
          email: null,
          tenant: TENANT_A,
          membership: {
            id: "aaaaaaaa-1111-4111-8111-111111111111",
            tenantId: TENANT_A.id,
            subject: "sub-1",
            casdoorOrg: null,
            role: "SALES",
            dataScope: "ALL",
            teamId: null,
            approvalLimitAmount: null,
            status: "ACTIVE",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          capabilities: roleCapabilities({ role: "SALES" }),
        }),
      ),
    );
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl,
    });
    const context = await client.switchTenant({ tenantId: TENANT_A.id });
    expect(context.tenant.id).toBe(TENANT_A.id);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://api.test/api/auth/switch");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ tenantId: TENANT_A.id });
  });

  it("切换被拒时保留可判别错误码，供页面渲染原因", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(
            { error: { code: "TENANT_UNAVAILABLE", message: "你没有这家公司的权限" } },
            403,
          ),
        ),
    });
    await expect(client.switchTenant({ tenantId: TENANT_A.id })).rejects.toMatchObject({
      code: "TENANT_UNAVAILABLE",
      status: 403,
    });
  });
});
