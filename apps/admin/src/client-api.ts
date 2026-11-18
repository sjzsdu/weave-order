"use client";

import { ApiError, type FieldIssue } from "./api-error";

/**
 * 浏览器只调同源 BFF（/api/*），由服务端注入 httpOnly 令牌。
 * 不在组件里直连 :3002，也不在 localStorage 存 token。
 *
 * 失败时抛 ApiError，保留控制面错误码、字段级 issues 与请求编号；
 * 展示文案由 api-error.ts 统一映射，调用方不要直接使用 cause.message。
 */
export async function mutate<T = unknown>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // 浏览器网络层直接抛 TypeError（fetch failed / Failed to fetch），没有响应。
    throw new ApiError(0, "NETWORK", cause instanceof Error ? cause.message : "网络连接失败");
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: {
      code?: string;
      message?: string;
      issues?: FieldIssue[];
      requestId?: string;
    };
  } | null;
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(response.status, error?.code ?? "INTERNAL", error?.message ?? "", {
      issues: error?.issues,
      requestId: error?.requestId ?? response.headers.get("x-request-id") ?? undefined,
    });
  }
  return payload as T;
}
