import { describe, expect, it } from "vitest";
import {
  ApiErrorResponse,
  AuditAction,
  AuthMeResponse,
  CreateMembershipInput,
  CreateOrderInput,
  CreateQuoteShareInput,
  CreateReceivableInput,
  CreateRevisionRequestInput,
  CreateTenantInput,
  CustomerQuoteView,
  DraftRevision,
  Order,
  QuoteShare,
  Receivable,
  RevisionRequest,
  SwitchTenantInput,
  Tenant,
  TenantChoice,
} from "../src";

const ID = "123e4567-e89b-12d3-a456-426614174000";
const ID2 = "223e4567-e89b-12d3-a456-426614174000";
const TS = "2026-11-12T00:00:00.000Z";

describe("T0 契约：租户 / 成员", () => {
  it("租户与成员输入 strict 校验", () => {
    expect(() =>
      CreateTenantInput.parse({ slug: "acme", name: "Acme", casdoorOrg: "acme" }),
    ).not.toThrow();
    expect(() =>
      CreateTenantInput.parse({ slug: "ACME!", name: "Acme", casdoorOrg: "acme" }),
    ).toThrow();
    expect(() =>
      CreateTenantInput.parse({ slug: "acme", name: "Acme", casdoorOrg: "acme", tenantId: ID }),
    ).toThrow(/Unrecognized key/);

    expect(() =>
      CreateMembershipInput.parse({ tenantId: ID, subject: "sub-1", role: "OWNER" }),
    ).not.toThrow();
    expect(() =>
      CreateMembershipInput.parse({ tenantId: ID, subject: "sub-1", role: "ROOT" }),
    ).toThrow();
  });

  it("读取模型要求租户字段", () => {
    const tenant = {
      id: ID,
      slug: "acme",
      name: "Acme",
      brand: null,
      bank: null,
      currency: "CNY",
      settings: {},
      status: "ACTIVE",
      isolationMode: "SHARED_RLS",
      createdAt: TS,
      updatedAt: TS,
    };
    expect(Tenant.parse(tenant).id).toBe(ID);
    expect(() => Tenant.parse({ ...tenant, isolationMode: "CLOUD" })).toThrow();
  });
});

describe("T0 契约：订单 / 应收", () => {
  it("订单金额必须是整数分", () => {
    const input = {
      customerId: ID,
      code: "SO-001",
      currency: "CNY",
      items: [
        {
          sampleId: ID2,
          quantity: { value: 10, unit: "meter" },
          unitPrice: { amount: 1500, currency: "CNY" },
        },
      ],
    };
    expect(() => CreateOrderInput.parse(input)).not.toThrow();
    expect(() =>
      CreateOrderInput.parse({
        ...input,
        items: [{ ...input.items[0], unitPrice: { amount: 15.5, currency: "CNY" } }],
      }),
    ).toThrow();
  });

  it("订单读取模型", () => {
    const order = {
      id: ID,
      tenantId: ID,
      customerId: ID2,
      quoteId: null,
      code: "SO-001",
      status: "DRAFT",
      currency: "CNY",
      items: [
        {
          id: ID2,
          sampleId: ID2,
          position: 0,
          description: "全棉府绸",
          quantity: { value: 10, unit: "meter" },
          unitPrice: { amount: 1500, currency: "CNY" },
          lineTotal: { amount: 15000, currency: "CNY" },
        },
      ],
      total: { amount: 15000, currency: "CNY" },
      dueDate: null,
      progressPct: 0,
      createdAt: TS,
      updatedAt: TS,
    };
    expect(Order.parse(order).total.amount).toBe(15000);
  });

  it("应收金额非负、dueDate 必填", () => {
    expect(() =>
      CreateReceivableInput.parse({
        orderId: ID,
        amount: { amount: 15000, currency: "CNY" },
        dueDate: TS,
      }),
    ).not.toThrow();
    expect(() =>
      CreateReceivableInput.parse({
        orderId: ID,
        amount: { amount: -1, currency: "CNY" },
        dueDate: TS,
      }),
    ).toThrow();
    const receivable = {
      id: ID,
      tenantId: ID,
      orderId: ID2,
      customerId: ID2,
      amount: { amount: 15000, currency: "CNY" },
      paidAmount: { amount: 0, currency: "CNY" },
      dueDate: TS,
      status: "PENDING",
      paidAt: null,
      createdAt: TS,
    };
    expect(Receivable.parse(receivable).status).toBe("PENDING");
  });
});

describe("T0 契约：改稿 / 分享", () => {
  it("改稿请求默认 PENDING 且 patch 可为任意 JSON", () => {
    const parsed = CreateRevisionRequestInput.parse({
      entityType: "quote",
      entityId: ID,
      source: "CHAT",
      instruction: "把这个单价降到 12 元",
      patch: [{ op: "replace", path: "/items/0/unitPriceAmount", value: 1200 }],
      baseVersion: 3,
    });
    expect(parsed.source).toBe("CHAT");
    const request = {
      id: ID,
      tenantId: ID,
      entityType: "quote",
      entityId: ID2,
      source: "CHAT",
      instruction: "改价",
      patch: {},
      status: "PENDING",
      decision: null,
      reasonId: null,
      baseVersion: 3,
      requestedByType: "AGENT",
      requestedById: "agent-1",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: TS,
    };
    expect(RevisionRequest.parse(request).status).toBe("PENDING");
  });

  it("草稿修订版本号必须为正", () => {
    const draft = {
      id: ID,
      tenantId: ID,
      revisionRequestId: null,
      entityType: "quote",
      entityId: ID2,
      version: 1,
      patch: {},
      before: {},
      after: {},
      provenance: {},
      actorType: "AGENT",
      actorId: "agent-1",
      createdAt: TS,
    };
    expect(() => DraftRevision.parse(draft)).not.toThrow();
    expect(() => DraftRevision.parse({ ...draft, version: 0 })).toThrow();
  });

  it("分享只存哈希，客户视图不含成本字段", () => {
    expect(() => CreateQuoteShareInput.parse({ quoteId: ID, expiresInDays: 7 })).not.toThrow();
    const share = {
      id: ID,
      tenantId: ID,
      quoteId: ID2,
      version: 1,
      tokenHash: "a".repeat(64),
      expiresAt: TS,
      requirePhoneTail: false,
      allowPdf: true,
      revokedAt: null,
      createdBy: "human-1",
      createdAt: TS,
    };
    expect(QuoteShare.parse(share).tokenHash).toHaveLength(64);

    const view = {
      quoteNumber: "Q-001",
      tenantName: "Acme",
      customerName: "客户 A",
      currency: "CNY",
      lines: [
        {
          description: "全棉府绸",
          quantity: 10,
          unit: "meter",
          unitPriceAmount: 1500,
          lineTotalAmount: 15000,
        },
      ],
      subtotalAmount: 15000,
      totalAmount: 15000,
      expiresAt: TS,
      allowPdf: true,
    };
    expect(CustomerQuoteView.parse(view).lines).toHaveLength(1);
    expect(() => CustomerQuoteView.parse({ ...view, costFloorAmount: 1000 })).toThrow(
      /Unrecognized key/,
    );
  });
});

describe("WAN-81 契约：租户选择", () => {
  const choice = {
    tenantId: ID,
    slug: "acme",
    name: "Acme",
    brand: null,
    role: "SALES",
    tenantStatus: "ACTIVE",
    membershipStatus: "ACTIVE",
    available: true,
  };

  it("TenantChoice 只接受选择器需要的字段，多余字段一律拒绝", () => {
    expect(TenantChoice.parse(choice).tenantId).toBe(ID);
    // 停用的成员身份没有角色，避免暗示权限。
    expect(TenantChoice.parse({ ...choice, role: null }).role).toBeNull();
    expect(() => TenantChoice.parse({ ...choice, memberCount: 3 })).toThrow(/Unrecognized key/);
    expect(() => TenantChoice.parse({ ...choice, tenantStatus: "PENDING" })).toThrow();
  });

  it("AuthMeResponse 能区分「已绑定」与「待选择」两个分支", () => {
    const tenant = {
      id: ID,
      slug: "acme",
      name: "Acme",
      brand: null,
      bank: null,
      currency: "CNY" as const,
      settings: {},
      status: "ACTIVE" as const,
      isolationMode: "SHARED_RLS" as const,
      createdAt: TS,
      updatedAt: TS,
    };
    const membership = {
      id: ID2,
      tenantId: ID,
      subject: "sub-1",
      casdoorOrg: null,
      role: "OWNER" as const,
      dataScope: "ALL" as const,
      teamId: null,
      approvalLimitAmount: null,
      status: "ACTIVE" as const,
      createdAt: TS,
      updatedAt: TS,
    };

    const bound = AuthMeResponse.parse({
      subject: "sub-1",
      name: null,
      email: null,
      tenant,
      membership,
    });
    expect("tenants" in bound).toBe(false);

    const chooser = AuthMeResponse.parse({
      status: "MULTI_TENANT",
      subject: "sub-1",
      name: null,
      email: null,
      tenants: [choice],
    });
    expect("tenants" in chooser).toBe(true);
    // 空列表不是合法选择页：前端应拿到 NO_MEMBERSHIP 错误码而不是空数组。
    expect(() =>
      AuthMeResponse.parse({
        status: "MULTI_TENANT",
        subject: "sub-1",
        name: null,
        email: null,
        tenants: [],
      }),
    ).toThrow();
  });

  it("SwitchTenantInput 是 strict 的，只接受 tenantId", () => {
    expect(SwitchTenantInput.parse({ tenantId: ID }).tenantId).toBe(ID);
    expect(() => SwitchTenantInput.parse({ tenantId: "not-a-uuid" })).toThrow();
    expect(() => SwitchTenantInput.parse({ tenantId: ID, org: "acme" })).toThrow(
      /Unrecognized key/,
    );
  });

  it("错误码保留可判别的租户语义，前端才能给不同文案", () => {
    for (const code of ["NO_MEMBERSHIP", "TENANT_UNAVAILABLE", "TENANT_REQUIRED"]) {
      expect(ApiErrorResponse.parse({ error: { code, message: "x" } }).error.code).toBe(code);
    }
  });

  it("审计动作集合包含 TENANT_SWITCHED", () => {
    expect(AuditAction.parse("TENANT_SWITCHED")).toBe("TENANT_SWITCHED");
  });
});
