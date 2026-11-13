import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { ZodError } from "zod";
import type { Response } from "express";
import { PlatformError } from "../domain/errors";

/** 统一错误信封：{ error: { code, message, issues? } }，不泄露 SQL / 堆栈。 */
@Catch()
export class PlatformErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("PlatformError");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof PlatformError) {
      response.status(exception.status).json({
        error: { code: exception.code, message: exception.message },
      });
      return;
    }
    if (exception instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "请求参数校验失败",
          issues: exception.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
        },
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === "string"
          ? body
          : typeof body === "object" && body !== null && "message" in body
            ? String(body.message)
            : exception.message;
      response.status(status).json({
        error: { code: status === 401 ? "UNAUTHENTICATED" : "INVALID_INPUT", message },
      });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    response.status(500).json({
      error: { code: "INTERNAL", message: "控制面内部错误，请查看服务日志" },
    });
  }
}
