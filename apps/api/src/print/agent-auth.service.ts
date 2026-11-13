import { Inject, Injectable } from "@nestjs/common";
import { openTenantSession } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { jwtVerify } from "jose";
import { AppDatabaseProvider } from "../platform/database.provider";
import { loadEnv } from "../platform/env";
import {
  PrintDeviceService,
  PRINT_AGENT_AUDIENCE,
  PRINT_AGENT_ISSUER,
} from "./print-devices.service";
import { PrintError } from "./template-engine";

export interface AgentIdentity {
  agentId: string;
  tenantId: string;
}

/** 代理请求拿到的租户会话类型（供 http 层标注回调参数，避免直连 db 包）。 */
export type AgentDb = Db;

/**
 * 打印代理认证：token 只带 tenant + agent + print 作用域。
 * 每个请求/消息打开一条租户会话，RLS 与人工请求完全一致。
 */
@Injectable()
export class PrintAgentAuthService {
  constructor(@Inject(AppDatabaseProvider) private readonly databases: AppDatabaseProvider) {}

  async verify(token: string): Promise<AgentIdentity> {
    let tenantId: string;
    let agentId: string;
    try {
      const verified = await jwtVerify(
        token,
        new TextEncoder().encode(loadEnv().PRINT_AGENT_SECRET),
        { issuer: PRINT_AGENT_ISSUER, audience: PRINT_AGENT_AUDIENCE },
      );
      const payload = verified.payload as Record<string, unknown>;
      if (
        payload.scope !== "print" ||
        typeof payload.tid !== "string" ||
        typeof payload.sub !== "string"
      ) {
        throw new Error("scope");
      }
      tenantId = payload.tid;
      agentId = payload.sub;
    } catch {
      throw new PrintError("PRINT_AGENT_UNAUTHORIZED", "打印代理 token 无效或已过期");
    }
    const session = await openTenantSession(this.databases.pool, tenantId);
    try {
      const devices = new PrintDeviceService(session.db, tenantId);
      const identity = await devices.authenticate(token);
      if (identity.agentId !== agentId) {
        throw new PrintError("PRINT_AGENT_UNAUTHORIZED", "打印代理身份不匹配");
      }
      return identity;
    } finally {
      await session.release();
    }
  }

  async withAgent<T>(
    identity: AgentIdentity,
    fn: (db: Db, agentId: string) => Promise<T>,
  ): Promise<T> {
    const session = await openTenantSession(this.databases.pool, identity.tenantId);
    try {
      return await fn(session.db, identity.agentId);
    } finally {
      await session.release();
    }
  }

  async withToken<T>(token: string, fn: (db: Db, identity: AgentIdentity) => Promise<T>) {
    const identity = await this.verify(token);
    return this.withAgent(identity, (db, agentId) =>
      fn(db, { agentId, tenantId: identity.tenantId }),
    );
  }
}
