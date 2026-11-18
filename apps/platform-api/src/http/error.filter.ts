import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ZodError, type ZodIssue } from "zod";
import type { Request, Response } from "express";
import { PlatformError } from "../domain/errors";

/**
 * Zod v3 把 minimum/maximum/type/options 等直接放在 issue 上，v4 收进 params。
 * 统一成 params 一个对象，管理端只依赖这一种形状。
 */
function issueParams(issue: ZodIssue): Record<string, unknown> | undefined {
  const source = issue as unknown as Record<string, unknown>;
  if (source.params && typeof source.params === "object") {
    return source.params as Record<string, unknown>;
  }
  const keys = [
    "minimum",
    "maximum",
    "type",
    "options",
    "validation",
    "received",
    "expected",
    "inclusive",
    "exact",
    "keys",
  ];
  const params = Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * 统一错误信封：{ error: { code, message, issues?, requestId } }，不泄露 SQL / 堆栈。
 *
 * issues 会把 Zod 的字段路径、错误码和参数带到管理端，由管理端翻译成中文的
 * 「哪个字段、为什么错、怎么改」；管理端不直接展示这里的 message。
 * 每个错误响应都带 requestId（同时写入 x-request-id 响应头），
 * 未知错误也能凭编号在容器日志里定位。
 */
@Catch()
export class PlatformErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("PlatformError");

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const requestId =
      (typeof request.headers["x-request-id"] === "string" && request.headers["x-request-id"]) ||
      randomUUID();
    response.setHeader("x-request-id", requestId);

    if (exception instanceof PlatformError) {
      response.status(exception.status).json({
        error: { code: exception.code, message: exception.message, requestId },
      });
      return;
    }
    if (exception instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "请求参数校验失败",
          issues: exception.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
            message: issue.message,
            params: issueParams(issue),
          })),
          requestId,
        },
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const rawMessage =
        typeof body === "string"
          ? body
          : typeof body === "object" && body !== null && "message" in body
            ? body.message
            : exception.message;
      const message = Array.isArray(rawMessage) ? rawMessage.join("；") : String(rawMessage);
      response.status(status).json({
        error: { code: status === 401 ? "UNAUTHENTICATED" : "INVALID_INPUT", message, requestId },
      });
      return;
    }

    this.logger.error(
      `[${requestId}] ${exception instanceof Error ? exception.stack : String(exception)}`,
    );
    response.status(500).json({
      error: {
        code: "INTERNAL",
        message: "控制面内部错误，请稍后重试",
        requestId,
      },
    });
  }
}
