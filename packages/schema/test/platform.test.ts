import { describe, expect, it } from "vitest";
import {
  BreakGlassInput,
  InvoiceSettingsInput,
  PlatformLlmSettingsInput,
  PricingPreviewInput,
  ProvisionTenantInput,
  UsageEventInput,
} from "../src/platform";

describe("控制面契约", () => {
  it("开通公司有安全默认值（月付 / 共享 RLS / 14 天试用）", () => {
    const parsed = ProvisionTenantInput.parse({
      name: "青禾纺织",
      slug: "qinghe",
      planCode: "PRO",
      seats: 10,
    });
    expect(parsed.billingCycle).toBe("MONTHLY");
    expect(parsed.isolationMode).toBe("SHARED_RLS");
    expect(parsed.trialDays).toBe(14);
  });

  it("拒绝非法 slug 与非整数席位", () => {
    expect(() =>
      ProvisionTenantInput.parse({ name: "X", slug: "Bad Slug", planCode: "PRO", seats: 1 }),
    ).toThrow();
    expect(() =>
      ProvisionTenantInput.parse({ name: "X", slug: "ok", planCode: "PRO", seats: 1.5 }),
    ).toThrow();
  });

  it("用量事件必须有 ≥8 位幂等键", () => {
    expect(() =>
      UsageEventInput.parse({
        tenantId: "x",
        kind: "agent_action",
        quantity: 1,
        idempotencyKey: "short",
      }),
    ).toThrow();
  });

  it("税率以基点表示且有上限", () => {
    expect(InvoiceSettingsInput.parse({ taxRateBp: 600 }).taxRateBp).toBe(600);
    expect(() => InvoiceSettingsInput.parse({ taxRateBp: 20000 })).toThrow();
  });

  it("LLM 覆盖只接受受控枚举", () => {
    expect(PlatformLlmSettingsInput.parse({ scope: "GLOBAL" }).scope).toBe("GLOBAL");
    expect(() => PlatformLlmSettingsInput.parse({ scope: "USER" })).toThrow();
  });

  it("试算输入拒绝非正席位", () => {
    expect(() =>
      PricingPreviewInput.parse({ planCode: "PRO", seats: 0, billingCycle: "MONTHLY" }),
    ).toThrow();
  });

  it("break-glass 输入显式携带租户同意", () => {
    const parsed = BreakGlassInput.parse({
      tenantId: "123e4567-e89b-12d3-a456-426614174000",
      ticketNo: "TCK-1",
      reason: "核对",
      tenantConsent: true,
    });
    expect(parsed.tenantConsent).toBe(true);
  });
});
