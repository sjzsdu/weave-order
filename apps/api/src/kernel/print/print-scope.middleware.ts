import { Injectable } from "@nestjs/common";
import { jwtVerify } from "jose";
import type { IncomingMessage } from "node:http";
import { loadEnv } from "../../platform/env";
import { PRINT_AGENT_AUDIENCE, PRINT_AGENT_ISSUER } from "./print-devices.service";

interface RequestLike extends IncomingMessage {
  originalUrl?: string;
}

interface ResponseLike {
  status(code: number): { json(body: unknown): void };
}

type Next = (error?: unknown) => void;

/**
 * 「token 只能打印，不能读业务数据」的硬闸门。
 *
 * 打印代理 token 一旦出现在任何非 `/api/print/agent/*` 路由上，
 * 即使目标路由本身是公开的（只读目录），也直接 403。
 * 这样即使将来有人误把业务接口做成无鉴权，代理 token 也拿不到数据。
 */
@Injectable()
export class PrintAgentScopeMiddleware {
  async use(request: RequestLike, response: ResponseLike, next: Next): Promise<void> {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "");
    if (!match?.[1]) {
      next();
      return;
    }
    const token = match[1];
    if (!token.includes(".")) {
      next();
      return;
    }
    try {
      await jwtVerify(token, new TextEncoder().encode(loadEnv().PRINT_AGENT_SECRET), {
        issuer: PRINT_AGENT_ISSUER,
        audience: PRINT_AGENT_AUDIENCE,
      });
    } catch {
      // 不是打印代理 token：交给原有鉴权路径处理。
      next();
      return;
    }
    const path = (request.originalUrl ?? "").split("?")[0] ?? "";
    if (path.startsWith("/api/print/agent/")) {
      next();
      return;
    }
    response.status(403).json({
      error: {
        code: "PRINT_AGENT_SCOPE_DENIED",
        message: "打印代理 token 只能用于打印任务，不能读取业务数据",
      },
    });
  }
}
