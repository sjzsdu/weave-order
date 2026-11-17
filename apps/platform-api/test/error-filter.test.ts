import { describe, expect, it } from "vitest";
import type { ArgumentsHost } from "@nestjs/common";
import { z } from "zod";
import { PlatformErrorFilter } from "../src/http/error.filter";

type Captured = {
  status?: number;
  body?: unknown;
  headers: Record<string, unknown>;
};

function run(exception: unknown, headers: Record<string, string> = {}): Captured {
  const captured: Captured = { headers: {} };
  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
    setHeader(key: string, value: unknown) {
      captured.headers[key] = value;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ headers, method: "POST", url: "/platform/api/settings/configs" }),
    }),
  } as unknown as ArgumentsHost;
  new PlatformErrorFilter().catch(exception, host);
  return captured;
}

describe("控制面错误信封", () => {
  it("Zod 失败带字段路径、错误码与参数，供管理端翻译", () => {
    let zodError: unknown;
    try {
      z.object({
        prices: z.array(z.object({ monthlyPriceCents: z.number().min(0) })),
        key: z.string().min(1),
      }).parse({ prices: [{ monthlyPriceCents: -1 }], key: "" });
    } catch (error) {
      zodError = error;
    }

    const result = run(zodError);
    expect(result.status).toBe(400);
    const error = (result.body as { error: Record<string, unknown> }).error;
    expect(error.code).toBe("INVALID_INPUT");
    expect(typeof error.requestId).toBe("string");
    const issues = error.issues as Array<{
      path: string;
      code: string;
      params?: Record<string, unknown>;
    }>;
    const priceIssue = issues.find((issue) => issue.path === "prices.0.monthlyPriceCents");
    expect(priceIssue?.code).toBe("too_small");
    expect(priceIssue?.params).toMatchObject({ minimum: 0 });
    expect(issues.some((issue) => issue.path === "key")).toBe(true);
    expect(result.headers["x-request-id"]).toBe(error.requestId);
  });

  it("沿用调用方的请求编号，便于串联 BFF 日志", () => {
    const result = run(new Error("boom"), { "x-request-id": "req-123" });
    expect(result.status).toBe(500);
    expect(result.headers["x-request-id"]).toBe("req-123");
    expect((result.body as { error: Record<string, unknown> }).error).toMatchObject({
      code: "INTERNAL",
      requestId: "req-123",
    });
    expect(JSON.stringify(result.body)).not.toContain("boom");
  });
});
