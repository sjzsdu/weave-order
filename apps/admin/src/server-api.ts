import { cookies } from "next/headers";

/**
 * 服务端读取控制面：令牌只存在 httpOnly Cookie，浏览器脚本拿不到。
 * 本地 dev 无登录时回退 dev:owner（生产构建绝不回退）。
 */
export const PLATFORM_API_URL = (process.env.PLATFORM_API_URL ?? "http://localhost:3002").replace(
  /\/$/,
  "",
);

export async function tokenFromCookies(): Promise<string | null> {
  const store = await cookies();
  const token = store.get("weave_platform_token")?.value;
  if (token) return token;
  if (process.env.NODE_ENV !== "production") {
    return process.env.DEV_PLATFORM_TOKEN ?? "dev:owner";
  }
  return null;
}

export class PlatformApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

export async function platformFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await tokenFromCookies();
  if (!token) throw new PlatformApiError(401, "UNAUTHENTICATED", "请先登录平台控制台");
  const url = `${PLATFORM_API_URL}/platform/api${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });
  } catch (cause) {
    console.error("[admin] 控制面不可达", {
      path,
      message: cause instanceof Error ? cause.message : String(cause),
    });
    throw new PlatformApiError(502, "PLATFORM_UNREACHABLE", "控制面不可达，请稍后重试");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const code = body?.error?.code ?? "INTERNAL";
    const message = body?.error?.message ?? `控制面返回 ${response.status}`;
    console.error("[admin] 控制面返回错误", { path, status: response.status, code, message });
    throw new PlatformApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

export async function currentActor() {
  return platformFetch<{
    subject: string;
    name: string;
    email: string;
    role: string;
    permissions: string[];
    mfaRequired: boolean;
  }>("/auth/me");
}

export function can(actor: { permissions: string[] }, permission: string): boolean {
  return actor.permissions.includes(permission);
}
