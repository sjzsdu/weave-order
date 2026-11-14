/**
 * 与织序 API 的最小 HTTP 客户端。
 *
 * - 只用 Node 20 内置 fetch，不引第三方依赖（agent 环境里少一个安装面）；
 * - 统一错误语义：服务端的 `{ error: { code, message } }` 原样保留为 ApiError.code；
 * - 网络失败给出可执行的提示（API 没起 / 地址写错），而不是 ECONNREFUSED 栈。
 */

export interface ApiOptions {
  serverUrl: string;
  token?: string;
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NetworkError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
  message?: string;
}

/** 工具 / 审批面的失败体：`{ ok: false, error: { code, message } }`（不引 zod，保持零依赖）。 */
function isToolFailure(
  payload: unknown,
  status: number,
): payload is { ok: false; error: { code: string; message: string } } {
  if (status >= 500) return false;
  const candidate = payload as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
  return (
    candidate?.ok === false &&
    typeof candidate.error?.code === "string" &&
    typeof candidate.error?.message === "string"
  );
}

const DEFAULT_TIMEOUT_MS = 20_000;

export async function request<T>(
  options: ApiOptions,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${options.serverUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new NetworkError(
      `无法连接 ${url}（${cause}）。请确认 API 已启动，或用 --server / WEAVE_SERVER 指定地址。`,
      error,
    );
  }

  const text = await response.text();
  let payload: unknown = undefined;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    // 与前端 transport 同规则：4xx + `{ok:false,error}` 是业务失败而非传输异常，
    // 原样交回响应体，`weave tool` 的 `result.ok` 分支才能继续拿到 issues / reason。
    if (isToolFailure(payload, response.status)) return payload as T;
    const errorBody = (payload ?? {}) as ErrorBody;
    const code = errorBody.error?.code ?? `HTTP_${response.status}`;
    const message =
      errorBody.error?.message ??
      errorBody.message ??
      (typeof payload === "string" ? payload.slice(0, 300) : response.statusText);
    throw new ApiError(code, message || `请求失败（HTTP ${response.status}）`, response.status);
  }

  return payload as T;
}

/** CLI 退出码：调用方（agent）据此分流，无需解析文案。 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  NETWORK: 4,
} as const;

export function exitCodeFor(error: unknown): number {
  if (error instanceof ApiError) {
    if (error.code === "USAGE") return EXIT.USAGE;
    return error.status === 401 || error.status === 403 ? EXIT.AUTH : EXIT.ERROR;
  }
  if (error instanceof NetworkError) return EXIT.NETWORK;
  return EXIT.ERROR;
}

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface MembershipView {
  id: string;
  tenantId: string;
  subject: string;
  casdoorOrg: string | null;
  role: string;
  dataScope: string;
  status: string;
}

export interface TenantView {
  id: string;
  slug: string;
  name: string;
}

/** `GET /api/auth/whoami`：凭据 + 成员身份 + 租户。 */
export interface WhoAmIView {
  subject: string;
  tenant: TenantView;
  membership: MembershipView;
  token: ApiTokenView | null;
}

export interface DeviceStartView {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollView =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | {
      status: "approved";
      token: string;
      tokenView: ApiTokenView;
      membership: MembershipView;
      tenant: TenantView;
    }
  | { status: "denied" }
  | { status: "expired" };

export interface ToolResultView {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface ApiClient {
  readonly serverUrl: string;
  readonly token?: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

export function createClient(options: ApiOptions): ApiClient {
  return {
    serverUrl: options.serverUrl,
    token: options.token,
    get: <T>(path: string) => request<T>(options, "GET", path),
    post: <T>(path: string, body?: unknown) => request<T>(options, "POST", path, body),
    del: <T>(path: string) => request<T>(options, "DELETE", path),
  };
}
