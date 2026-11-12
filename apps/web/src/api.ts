import type {
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalQueue,
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
 * 铁律：这里只有「只读目录 / 全景」「工具（agent 身份产草稿）」「审批决策」三类调用，
 * 没有任何写业务表、直连内核、绕过 tools 的端点。DRAFT 生效只能经由
 * approvals/decide（HUMAN 上下文 -> 内核 confirm/reject）。
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
    throw new ApiError(response.status, `HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

export const apiClient = {
  customers: () => request<{ customers: Customer[] }>("/api/customers?limit=100"),
  samples: () => request<{ samples: FabricSample[] }>("/api/samples?limit=100"),
  queue: () => request<ApprovalQueue>("/api/approvals"),
  panorama: () => request<PanoramaSnapshot>("/api/panorama"),

  decide: (input: ApprovalDecisionInput) =>
    request<ApprovalDecisionResult>("/api/approvals/decide", postJson(input)),

  generateQuoteDraft: (body: T004GenerateQuoteDraftInput) =>
    request<T004GenerateQuoteDraftResult>("/api/tools/generate-quote-draft", postJson(body)),
  createSampleShipment: (body: T005CreateSampleShipmentInput) =>
    request<T005CreateSampleShipmentResult>("/api/tools/create-sample-shipment", postJson(body)),
  searchBySpec: (body: T002SearchFabricBySpecInput) =>
    request<T002SearchFabricBySpecResult>("/api/tools/search-by-spec", postJson(body)),
};
