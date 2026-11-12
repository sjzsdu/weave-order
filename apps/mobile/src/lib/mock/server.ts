import {
  ApprovalDecisionInput,
  CreateQuoteShareInput,
  CreateRevisionRequestInput,
  DecideRevisionRequestInput,
  T002SearchFabricBySpecInput,
  T004GenerateQuoteDraftInput,
} from "@weave-order/schema";
import type {
  ApprovalItem,
  AuditLogEntry,
  CreatedQuoteShare,
  DraftRevision,
  RevisionRequest,
  T002SearchFabricBySpecResult,
  T004GenerateQuoteDraftResult,
  T001SearchFabricByImageResult,
} from "@weave-order/schema";
import {
  MOCK_CUSTOMERS,
  MOCK_SAMPLES,
  MOCK_TENANT_ID,
  initialApprovals,
  initialAudit,
  initialQuotes,
} from "./seed";
import type { MockShareRecord, MockState, MockStorage, QuoteRecord } from "./types";

/**
 * 本地 mock 服务端：实现移动端 P0 会用到的契约端点。
 *
 * 它不是「假数据散落在页面里」，而是与真实后端同一套 Zod 契约的
 * 一个内存实现 —— 页面代码只依赖 `MobileApi`，切到真后端时不用改 UI。
 * 端点形状与 Track A 的 HTTP 面一致；尚未冻结的端点（revisions / presign /
 * proof）在 README 里标注为待联调契约。
 */

export interface MockServerOptions {
  storage: MockStorage;
  latencyMs?: number;
  now?: () => Date;
}

export interface MockServer {
  fetch: (input: string, init?: RequestInit) => Promise<MockResponse>;
  setOffline(offline: boolean): void;
  isOffline(): boolean;
  /** 模拟另一端已经改了报价，用来演练离线冲突。 */
  simulateRemoteEdit(quoteId?: string): { version: number; total: number };
  reset(): void;
}

interface MockResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type Body = Record<string, unknown>;

function jsonResponse(status: number, body: unknown): MockResponse {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
  };
}

function isMockResponse(value: unknown): value is MockResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    "status" in value &&
    typeof (value as { text?: unknown }).text === "function"
  );
}

function fail(status: number, code: string, message: string, details?: unknown): MockResponse {
  return jsonResponse(status, { error: { code, message, ...(details ? { details } : {}) } });
}

function uuid(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += hex[Math.floor(Math.random() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-8${out.slice(17, 20)}-${out.slice(20, 32)}`;
}

function token(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  let out = "";
  for (let i = 0; i < 48; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function hash32(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

function stateFromSeed(now: Date): MockState {
  const quotes = initialQuotes(now);
  return {
    quotes,
    approvals: initialApprovals(quotes, now),
    revisions: [],
    shares: [],
    audit: initialAudit(now),
    seq: 4,
    offline: false,
  };
}

function readBody(init?: RequestInit): Body {
  if (!init?.body || typeof init.body !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(init.body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Body) : {};
  } catch {
    return {};
  }
}

function recalc(quote: QuoteRecord): void {
  const subtotal = quote.items.reduce((sum, item) => sum + item.lineTotal.amount, 0);
  quote.subtotal = { amount: subtotal, currency: quote.currency };
  quote.total = { amount: subtotal, currency: quote.currency };
}

function summaryFor(quote: QuoteRecord): string {
  const first = quote.items[0];
  if (!first) return "空报价";
  return `${first.quantity.value} ${first.quantity.unit === "meter" ? "米" : first.quantity.unit} × ${(
    first.unitPrice.amount / 100
  ).toFixed(
    2,
  )} 元/${first.quantity.unit === "meter" ? "米" : "单位"} · 有效期 ${quote.validityDays} 天`;
}

function draftView(quote: QuoteRecord): T004GenerateQuoteDraftResult {
  return {
    ok: true,
    data: {
      draft: {
        id: quote.id,
        tenantId: quote.tenantId,
        customerId: quote.customerId,
        status: "DRAFT",
        currency: quote.currency,
        items: quote.items,
        subtotal: quote.subtotal,
        total: quote.total,
        amountsComputedByKernel: true,
        validityDays: quote.validityDays,
        expiresAt: quote.expiresAt,
        createdAt: quote.createdAt,
        remarks: quote.remarks,
      },
    },
  };
}

export function createMockServer(options: MockServerOptions): MockServer {
  const latency = options.latencyMs ?? 140;
  const now = options.now ?? (() => new Date());
  let state = options.storage.load() ?? stateFromSeed(now());
  const persist = () => options.storage.save(state);

  const audit = (entry: Omit<AuditLogEntry, "id" | "tenantId" | "seq" | "createdAt">): void => {
    state.seq += 1;
    state.audit = [
      {
        ...entry,
        id: uuid(),
        tenantId: MOCK_TENANT_ID,
        seq: state.seq,
        createdAt: now().toISOString(),
      },
      ...state.audit,
    ];
  };

  const quoteById = (id: string) => state.quotes.find((quote) => quote.id === id);
  const customerById = (id: string) => MOCK_CUSTOMERS.find((customer) => customer.id === id);

  const touchApproval = (quote: QuoteRecord): void => {
    state.approvals = state.approvals.map((item) =>
      item.id === quote.id
        ? {
            ...item,
            summary: summaryFor(quote),
            amountCents: quote.total.amount,
            currency: quote.currency,
          }
        : item,
    );
  };

  const searchSpec = (body: Body): T002SearchFabricBySpecResult => {
    const parsed = T002SearchFabricBySpecInput.safeParse(body);
    if (!parsed.success) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "检索词不合法", issues: [] } };
    }
    const query = parsed.data.query.toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const matches = MOCK_SAMPLES.map((sample) => {
      const fields: Array<["code" | "name" | "composition" | "weight", string]> = [
        ["code", sample.code],
        ["name", sample.name],
        ["composition", sample.composition ?? ""],
        ["weight", sample.weight ?? ""],
      ];
      const matchedOn: Array<"code" | "name" | "composition" | "weight"> = [];
      for (const [field, value] of fields) {
        if (tokens.some((tokenPart) => value.toLowerCase().includes(tokenPart)))
          matchedOn.push(field);
      }
      const score = matchedOn.length / fields.length;
      return { sample, score, matchedOn };
    })
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, parsed.data.limit);
    return { ok: true, data: { matches } };
  };

  const generateDraft = (body: Body): T004GenerateQuoteDraftResult => {
    const parsed = T004GenerateQuoteDraftInput.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "报价入参未通过校验",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map((segment) =>
              typeof segment === "number" ? segment : String(segment),
            ),
            code: issue.code,
            message: issue.message,
          })),
        },
      };
    }
    if (!customerById(parsed.data.customerId)) {
      return {
        ok: false,
        error: {
          code: "CUSTOMER_NOT_FOUND",
          message: "客户不存在",
          customerId: parsed.data.customerId,
        },
      };
    }
    const items = [];
    for (const input of parsed.data.items) {
      const sample = MOCK_SAMPLES.find((entry) => entry.id === input.fabricSampleId);
      if (!sample) {
        return {
          ok: false,
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "样品不存在",
            resourceType: "fabric_sample",
            resourceId: input.fabricSampleId,
          },
        };
      }
      // 单价 0 表示「客户没提价」：由报价助手给建议价（mock 用成本底线 × 1.18）。
      const base =
        input.unitPrice.amount > 0
          ? input.unitPrice.amount
          : Math.round(((sample.costFloor?.amount ?? 1000) * 118) / 100 / 10) * 10;
      const lineTotal = Math.round(base * input.quantity.value);
      items.push({
        fabricSampleId: sample.id,
        description: sample.name,
        quantity: input.quantity,
        unitPrice: { amount: base, currency: parsed.data.currency },
        lineTotal: { amount: lineTotal, currency: parsed.data.currency },
      });
    }
    const subtotal = items.reduce((sum, item) => sum + item.lineTotal.amount, 0);
    const createdAt = now();
    const quote: QuoteRecord = {
      id: uuid(),
      tenantId: MOCK_TENANT_ID,
      customerId: parsed.data.customerId,
      status: "DRAFT",
      currency: parsed.data.currency,
      items,
      subtotal: { amount: subtotal, currency: parsed.data.currency },
      total: { amount: subtotal, currency: parsed.data.currency },
      amountsComputedByKernel: true,
      validityDays: parsed.data.validityDays,
      expiresAt: new Date(
        createdAt.getTime() + parsed.data.validityDays * 24 * 3600_000,
      ).toISOString(),
      createdAt: createdAt.toISOString(),
      remarks: parsed.data.remarks ?? null,
      version: 1,
    };
    state.quotes.push(quote);
    const customer = customerById(quote.customerId);
    const approval: ApprovalItem = {
      id: quote.id,
      kind: "quote",
      title: `报价 · ${customer?.name ?? "客户"}`,
      summary: summaryFor(quote),
      status: "DRAFT",
      pending: true,
      amountCents: quote.total.amount,
      currency: quote.currency,
      customerId: quote.customerId,
      createdAt: quote.createdAt,
      confirmedBy: null,
    };
    state.approvals = [approval, ...state.approvals];
    audit({
      actorType: "AGENT",
      actorId: "小织",
      action: "QUOTE_DRAFT_GENERATED",
      entityType: "quote",
      entityId: quote.id,
      before: null,
      after: { total: quote.total.amount, items: quote.items.length },
      correlationId: null,
    });
    persist();
    return draftView(quote);
  };

  const createRevision = (body: Body): RevisionRequest | MockResponse => {
    const parsed = CreateRevisionRequestInput.safeParse(body);
    if (!parsed.success) return fail(400, "INVALID_INPUT", "改稿入参未通过校验");
    const quote = quoteById(parsed.data.entityId);
    if (!quote) return fail(404, "NOT_FOUND", "报价不存在");
    if (quote.version !== parsed.data.baseVersion || quote.status !== "DRAFT") {
      return fail(409, "CONFLICT", "报价已在其他端更新，请确认服务端版本", {
        serverVersion: quote.version,
        serverSnapshot: { total: quote.total.amount, items: quote.items },
      });
    }
    const before = quote.items;
    const patch = parsed.data.patch as {
      items?: Array<{ fabricSampleId?: string; unitPrice?: { amount?: number } }>;
    };
    if (Array.isArray(patch.items)) {
      for (const patchItem of patch.items) {
        const line = quote.items.find((item) => item.fabricSampleId === patchItem.fabricSampleId);
        const amount = patchItem.unitPrice?.amount;
        if (!line || typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
          return fail(400, "INVALID_INPUT", "改价补丁不合法");
        }
        line.unitPrice = { amount, currency: quote.currency };
        line.lineTotal = {
          amount: Math.round(amount * line.quantity.value),
          currency: quote.currency,
        };
      }
    }
    recalc(quote);
    quote.version += 1;
    touchApproval(quote);

    const revision: RevisionRequest = {
      id: uuid(),
      tenantId: quote.tenantId,
      entityType: "quote",
      entityId: quote.id,
      source: parsed.data.source,
      instruction: parsed.data.instruction,
      patch: parsed.data.patch,
      status: "PENDING",
      decision: null,
      reasonId: parsed.data.reasonId ?? null,
      baseVersion: parsed.data.baseVersion,
      requestedByType: "HUMAN",
      requestedById: "mobile-user",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now().toISOString(),
    };
    state.revisions.push(revision);
    const draftRevision: DraftRevision = {
      id: uuid(),
      tenantId: quote.tenantId,
      revisionRequestId: revision.id,
      entityType: "quote",
      entityId: quote.id,
      version: quote.version,
      patch: parsed.data.patch,
      before,
      after: quote.items,
      provenance: { source: parsed.data.source, instruction: parsed.data.instruction },
      actorType: "HUMAN",
      actorId: "mobile-user",
      createdAt: now().toISOString(),
    };
    void draftRevision;
    audit({
      actorType: "HUMAN",
      actorId: "mobile-user",
      action: "REVISION_REQUESTED",
      entityType: "quote",
      entityId: quote.id,
      before: { total: before.reduce((sum, item) => sum + item.lineTotal.amount, 0) },
      after: { total: quote.total.amount, version: quote.version },
      correlationId: null,
    });
    persist();
    return revision;
  };

  const decideRevision = (body: Body): RevisionRequest | MockResponse => {
    const parsed = DecideRevisionRequestInput.safeParse(body);
    if (!parsed.success) return fail(400, "INVALID_INPUT", "裁决入参未通过校验");
    const revision = state.revisions.find((entry) => entry.id === parsed.data.revisionRequestId);
    if (!revision) return fail(404, "NOT_FOUND", "改稿请求不存在");
    revision.status = parsed.data.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    revision.decision = parsed.data.decision;
    revision.resolvedBy = "mobile-user";
    revision.resolvedAt = now().toISOString();
    audit({
      actorType: "HUMAN",
      actorId: "mobile-user",
      action: "REVISION_RESOLVED",
      entityType: revision.entityType,
      entityId: revision.entityId,
      before: { status: "PENDING" },
      after: { status: revision.status },
      correlationId: null,
    });
    persist();
    return revision;
  };

  const decideApproval = (body: Body): MockResponse => {
    const parsed = ApprovalDecisionInput.safeParse(body);
    if (!parsed.success) return fail(400, "INVALID_INPUT", "审批决策入参未通过校验");
    const approval = state.approvals.find((item) => item.id === parsed.data.id);
    if (!approval) return fail(404, "NOT_FOUND", "待审批单据不存在");
    if (approval.kind !== parsed.data.kind) return fail(400, "INVALID_INPUT", "单据类型不匹配");

    let status: ApprovalItem["status"];
    if (approval.kind === "quote") {
      const quote = quoteById(approval.id);
      if (!quote) return fail(404, "NOT_FOUND", "报价不存在");
      if (quote.status !== "DRAFT")
        return fail(409, "CONFLICT", "报价已被处理", { serverVersion: quote.version });
      status = parsed.data.decision === "APPROVE" ? "SENT" : "REJECTED";
      quote.status = status;
      quote.version += 1;
    } else {
      status = parsed.data.decision === "APPROVE" ? "CONFIRMED" : "CANCELLED";
    }
    state.approvals = state.approvals.filter((item) => item.id !== approval.id);
    audit({
      actorType: "HUMAN",
      actorId: "mobile-user",
      action:
        approval.kind === "quote"
          ? parsed.data.decision === "APPROVE"
            ? "QUOTE_CONFIRMED"
            : "QUOTE_REJECTED"
          : parsed.data.decision === "APPROVE"
            ? "SAMPLE_SHIPMENT_CONFIRMED"
            : "SAMPLE_SHIPMENT_REJECTED",
      entityType: approval.kind,
      entityId: approval.id,
      before: { status: "DRAFT" },
      after: { status, note: parsed.data.note ?? null },
      correlationId: null,
    });
    persist();
    return jsonResponse(200, {
      ok: true,
      data: {
        id: approval.id,
        kind: approval.kind,
        decision: parsed.data.decision,
        status,
        actorType: "HUMAN",
        decidedAt: now().toISOString(),
      },
    });
  };

  const createShare = (body: Body): CreatedQuoteShare | MockResponse => {
    const parsed = CreateQuoteShareInput.safeParse(body);
    if (!parsed.success) return fail(400, "INVALID_INPUT", "分享入参未通过校验");
    const quote = quoteById(parsed.data.quoteId);
    if (!quote) return fail(404, "NOT_FOUND", "报价不存在");
    if (quote.status === "DRAFT") return fail(400, "INVALID_INPUT", "草稿报价不能分享，请先批准");
    const plain = token();
    const shareId = uuid();
    const record: MockShareRecord = {
      share: {
        id: shareId,
        tenantId: quote.tenantId,
        quoteId: quote.id,
        version: quote.version,
        tokenHash: hash32(plain),
        expiresAt: new Date(
          now().getTime() + parsed.data.expiresInDays * 24 * 3600_000,
        ).toISOString(),
        requirePhoneTail: parsed.data.requirePhoneTail,
        allowPdf: parsed.data.allowPdf,
        revokedAt: null,
        createdBy: "mobile-user",
        createdAt: now().toISOString(),
      },
      events: [{ type: "CREATED", at: now().toISOString() }],
    };
    state.shares.push(record);
    audit({
      actorType: "HUMAN",
      actorId: "mobile-user",
      action: "QUOTE_SHARE_CREATED",
      entityType: "quote",
      entityId: quote.id,
      before: null,
      after: { shareId, version: quote.version, expiresAt: record.share.expiresAt },
      correlationId: null,
    });
    persist();
    // 明文 token / URL 只在创建这一刻返回，不写进 mock 的“服务端”存储。
    return { share: record.share, token: plain, url: `https://app.weaveorder.cn/s/${plain}` };
  };

  const handle = (
    method: string,
    path: string,
    search: URLSearchParams,
    body: Body,
  ): MockResponse => {
    if (method === "GET" && path === "/api/health")
      return jsonResponse(200, { ok: true, database: "mock" });

    if (method === "GET" && path === "/api/auth/me") {
      return jsonResponse(200, {
        subject: "mock-user",
        name: "孙巨中",
        email: "122828837@qq.com",
        tenant: {
          id: MOCK_TENANT_ID,
          slug: "weave-demo",
          name: "织序演示公司",
          brand: "织序",
          bank: null,
          currency: "CNY",
          settings: {},
          status: "ACTIVE",
          isolationMode: "SHARED_RLS",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        membership: {
          id: "99999999-9999-4999-8999-111111111111",
          tenantId: MOCK_TENANT_ID,
          subject: "mock-user",
          casdoorOrg: "weave-demo",
          role: "OWNER",
          dataScope: "ALL",
          teamId: null,
          approvalLimitAmount: null,
          status: "ACTIVE",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
    }

    if (method === "GET" && path === "/api/customers") {
      const limit = Number(search.get("limit") ?? 20);
      return jsonResponse(200, {
        customers: MOCK_CUSTOMERS.slice(0, Number.isFinite(limit) ? limit : 20),
      });
    }

    if (method === "GET" && path === "/api/samples") {
      const limit = Number(search.get("limit") ?? 50);
      return jsonResponse(200, {
        samples: MOCK_SAMPLES.slice(0, Number.isFinite(limit) ? limit : 50),
      });
    }

    if (method === "GET" && path === "/api/audit") {
      const limit = Number(search.get("limit") ?? 20);
      return jsonResponse(200, {
        entries: state.audit.slice(0, Number.isFinite(limit) ? limit : 20),
      });
    }

    if (method === "GET" && path === "/api/approvals")
      return jsonResponse(200, { items: state.approvals });

    if (method === "GET" && path.startsWith("/api/quotes/")) {
      const id = path.slice("/api/quotes/".length);
      const quote = quoteById(id);
      if (!quote) return fail(404, "NOT_FOUND", "报价不存在");
      const view = draftView(quote);
      if (!view.ok) return fail(500, "INTERNAL", "报价读取失败");
      return jsonResponse(200, {
        draft: view.data.draft,
        version: quote.version,
        status: quote.status,
      });
    }

    if (method === "GET" && path === "/api/panorama") {
      const quoteItems: ApprovalItem[] = state.quotes.map((quote) => ({
        id: quote.id,
        kind: "quote",
        title: `报价 · ${customerById(quote.customerId)?.name ?? "客户"}`,
        summary: summaryFor(quote),
        status: quote.status,
        pending: quote.status === "DRAFT",
        amountCents: quote.total.amount,
        currency: quote.currency,
        customerId: quote.customerId,
        createdAt: quote.createdAt,
        confirmedBy: null,
      }));
      const shipmentItems = state.approvals.filter((item) => item.kind === "sample_shipment");
      const items = [...quoteItems, ...shipmentItems].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      const pending = items.filter((item) => item.pending).length;
      return jsonResponse(200, {
        generatedAt: now().toISOString(),
        customers: MOCK_CUSTOMERS,
        samples: MOCK_SAMPLES,
        items,
        audit: state.audit,
        stats: {
          customerCount: MOCK_CUSTOMERS.length,
          sampleCount: MOCK_SAMPLES.length,
          quoteCount: state.quotes.length,
          shipmentCount: shipmentItems.length,
          pendingCount: pending,
          sentQuoteCount: state.quotes.filter((quote) => quote.status === "SENT").length,
          confirmedShipmentCount: 0,
          rejectedCount: state.quotes.filter((quote) => quote.status === "REJECTED").length,
          auditCount: state.audit.length,
        },
      });
    }

    if (method === "POST" && path === "/api/tools/search-by-spec")
      return jsonResponse(200, searchSpec(body));
    if (method === "POST" && path === "/api/tools/search-by-image") {
      if (typeof body.base64 === "string") {
        return fail(400, "INVALID_INPUT", "移动端禁止 base64 JSON，请先直传对象存储并传 imageUrl");
      }
      if (typeof body.imageUrl !== "string") {
        return fail(400, "INVALID_INPUT", "缺少 imageUrl");
      }
      const result: T001SearchFabricByImageResult = {
        ok: true,
        data: {
          embeddingModel: "mock-perceptual",
          dimension: 8,
          matches: MOCK_SAMPLES.slice(0, 4)
            .map((sample, index) => ({
              sample,
              score: Math.round((0.92 - index * 0.11) * 100) / 100,
            }))
            .filter((match) => match.score > 0),
        },
      };
      return jsonResponse(200, result);
    }
    if (method === "POST" && path === "/api/tools/generate-quote-draft")
      return jsonResponse(200, generateDraft(body));

    if (method === "POST" && path === "/api/approvals/decide") return decideApproval(body);

    if (method === "POST" && path === "/api/revisions") {
      const result = createRevision(body);
      return isMockResponse(result) ? result : jsonResponse(200, result);
    }
    if (method === "POST" && path === "/api/revisions/decide") {
      const result = decideRevision(body);
      return isMockResponse(result) ? result : jsonResponse(200, result);
    }

    if (method === "POST" && path === "/api/quote-shares") {
      const result = createShare(body);
      return isMockResponse(result) ? result : jsonResponse(200, result);
    }
    if (method === "GET" && path === "/api/quote-shares") {
      const quoteId = search.get("quoteId");
      const shares = state.shares
        .filter((entry) => !quoteId || entry.share.quoteId === quoteId)
        .map((entry) => ({
          share: entry.share,
          url: "",
          viewCount: entry.events.filter((event) => event.type === "VIEWED").length,
          lastViewedAt: entry.events.filter((event) => event.type === "VIEWED").at(-1)?.at ?? null,
        }));
      return jsonResponse(200, { shares });
    }

    if (method === "POST" && path === "/api/media/presign") {
      const mime = typeof body.mimeType === "string" ? body.mimeType : "image/jpeg";
      const id = uuid();
      return jsonResponse(200, {
        uploadUrl: `mock://upload/${id}`,
        publicUrl: `mock://media/${id}.${mime.split("/")[1] ?? "jpg"}`,
        method: "PUT",
        headers: { "Content-Type": mime },
      });
    }

    if (method === "POST" && path === "/api/shipments/proof") {
      const id = uuid();
      audit({
        actorType: "HUMAN",
        actorId: "mobile-user",
        action: "SHIPMENT_CONFIRMED",
        entityType: "shipment",
        entityId: id,
        before: null,
        after: {
          imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : null,
          trackingNumber: typeof body.trackingNumber === "string" ? body.trackingNumber : null,
        },
        correlationId: null,
      });
      persist();
      return jsonResponse(200, { id, recordedAt: now().toISOString() });
    }

    return fail(404, "NOT_FOUND", `mock 未实现 ${method} ${path}`);
  };

  return {
    async fetch(input, init) {
      if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
      if (state.offline) throw new TypeError("网络已断开（模拟）");
      const url = new URL(input, "http://mock.local");
      const method = (init?.method ?? "GET").toUpperCase();
      try {
        return handle(method, url.pathname, url.searchParams, readBody(init));
      } catch (error) {
        return fail(500, "INTERNAL", error instanceof Error ? error.message : "mock 内部错误");
      }
    },
    setOffline(offline) {
      state.offline = offline;
      persist();
    },
    isOffline() {
      return state.offline;
    },
    simulateRemoteEdit(quoteId) {
      const quote = quoteId
        ? quoteById(quoteId)
        : state.quotes.find((entry) => entry.status === "DRAFT");
      if (!quote) throw new Error("没有可模拟的草稿报价");
      const first = quote.items[0];
      if (first) {
        first.unitPrice = { amount: first.unitPrice.amount + 100, currency: quote.currency };
        first.lineTotal = {
          amount: Math.round(first.unitPrice.amount * first.quantity.value),
          currency: quote.currency,
        };
      }
      recalc(quote);
      quote.version += 1;
      touchApproval(quote);
      persist();
      return { version: quote.version, total: quote.total.amount };
    },
    reset() {
      state = stateFromSeed(now());
      options.storage.clear();
      persist();
    },
  };
}
