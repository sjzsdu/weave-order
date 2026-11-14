import { Injectable } from "@nestjs/common";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { map } from "rxjs";
import type { ToolError } from "@weave-order/schema";
import { statusForToolFailure } from "@weave-order/schema";

function toolFailure(body: unknown): ToolError | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as { ok?: unknown; error?: unknown };
  if (candidate.ok !== false || typeof candidate.error !== "object" || candidate.error === null) {
    return null;
  }
  const code = (candidate.error as { code?: unknown }).code;
  return typeof code === "string" ? (candidate.error as ToolError) : null;
}

/** 只用到状态码写入，不为一行代码引入 express 类型（同 print-scope.middleware 的写法）。 */
interface ResponseStatus {
  status(code: number): unknown;
}

/**
 * 智能体 / 审批面的 HTTP 语义收口。
 *
 * 这些路由把失败编码在 body 的 `ok:false`（工具契约，前端与 CLI 都按它判分支），
 * 但状态码不能因此停在 201：网关指标、重试策略与 agent 的判错都读状态码。
 */
@Injectable()
export class ToolStatusInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<ResponseStatus>();
    return next.handle().pipe(
      map((body: unknown) => {
        const failure = toolFailure(body);
        if (failure) response.status(statusForToolFailure(failure));
        return body;
      }),
    );
  }
}
