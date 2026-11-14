import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { ZodError } from "zod";
import { ContractZodError } from "@weave-order/schema";

/** 只用到 status().json()，不为一行代码引入 express 类型。 */
interface ResponseWriter {
  status(code: number): { json(body: unknown): void };
}

/**
 * 契约校验失败的统一出口。
 *
 * 内核 service 里大量入参用裸 `.parse()` 校验（`ReviseQuoteDraftInput` 等），
 * 抛出的 `ZodError` 不是 `KernelError`，控制器的 `rethrowHttp` 不认，
 * 会直达 Nest 默认处理器变成 500 + 完整堆栈日志。这里把它收敛成与
 * `auth/input.ts` 的 `parseInput` 同形的 400 `INVALID_INPUT`。
 *
 * `@Catch` 挂的是契约包那份 ZodError：契约 schema 抛的就是它，api 自己
 * `import "zod"` 拿到的可能是另一份实例，跨包判定会静默失效。
 */
@Catch(ContractZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ResponseWriter>();
    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: {
        code: "INVALID_INPUT",
        message: "请求参数不合法",
        issues: exception.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }
}
