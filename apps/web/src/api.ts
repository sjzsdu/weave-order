import type {
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalQueue,
  CreateCustomerInput,
  CreateSampleInput,
  Customer,
  FabricSample,
  PanoramaSnapshot,
  T002SearchFabricBySpecInput,
  T002SearchFabricBySpecResult,
  T004GenerateQuoteDraftInput,
  T004GenerateQuoteDraftResult,
  T005CreateSampleShipmentInput,
  T005CreateSampleShipmentResult,
} from "@weave-order/schema";

/**
 * 前端唯一的服务端入口。
 *
 * 铁律：这里只有「只读目录 / 全景」「工具（agent 身份产草稿）」「审批决策」
 * 「基础资料录入」四类调用。账本单据（报价 / 寄样）依然没有任何直写端点：
 * DRAFT 生效只能经由 approvals/decide（HUMAN 上下文 -> 内核 confirm/reject）。
 * 建客户 / 建样品只写主数据，供空库冷启动时把上下文准备好。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    // 写接口的失败原因在 body 里（400 校验 / 409 重复），优先展示可读中文。
    const readable = await readErrorMessage(response);
    throw new ApiError(response.status, readable);
  }
  return (await response.json()) as T;
}

/** 从 `{ ok: false, error: { message } }` 里取可读原因，取不到就退回状态行。 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const error: unknown = body.error;
      if (typeof error === "object" && error !== null && "message" in error) {
        const message: unknown = error.message;
        if (typeof message === "string" && message.length > 0) return message;
      }
    }
  } catch {
    // 非 JSON（代理错误页等）时保持默认文案。
  }
  return `HTTP ${response.status} ${response.statusText}`;
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

export const apiClient = {
  customers: () => request<{ customers: Customer[] }>("/api/customers?limit=100"),
  samples: () => request<{ samples: FabricSample[] }>("/api/samples?limit=100"),
  queue: () => request<ApprovalQueue>("/api/approvals"),
  panorama: () => request<PanoramaSnapshot>("/api/panorama"),

  /** 建客户：只写主数据，审计记 CUSTOMER_CREATED（HUMAN）。 */
  createCustomer: (body: CreateCustomerInput) =>
    request<{ ok: true; data: Customer }>("/api/customers", postJson(body)),
  /** 建样品：只写主数据，审计记 SAMPLE_CREATED（HUMAN）。 */
  createSample: (body: CreateSampleInput) =>
    request<{ ok: true; data: FabricSample }>("/api/samples", postJson(body)),

  decide: (input: ApprovalDecisionInput) =>
    request<ApprovalDecisionResult>("/api/approvals/decide", postJson(input)),

  generateQuoteDraft: (body: T004GenerateQuoteDraftInput) =>
    request<T004GenerateQuoteDraftResult>("/api/tools/generate-quote-draft", postJson(body)),
  createSampleShipment: (body: T005CreateSampleShipmentInput) =>
    request<T005CreateSampleShipmentResult>("/api/tools/create-sample-shipment", postJson(body)),
  searchBySpec: (body: T002SearchFabricBySpecInput) =>
    request<T002SearchFabricBySpecResult>("/api/tools/search-by-spec", postJson(body)),
};
