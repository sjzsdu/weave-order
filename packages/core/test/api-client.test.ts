import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../src/api-client";

const CUSTOMER = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  tenantId: "00000000-0000-0000-0000-000000000001",
  code: "C001",
  name: "杭州织造",
  tier: "VIP",
  contactName: null,
  contactPhone: null,
  contactEmail: null,
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
