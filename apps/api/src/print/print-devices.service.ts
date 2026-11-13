import { printAgents, printers } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  AgentHeartbeatInput,
  PrintAgent,
  Printer,
  RegisterPrintAgentInput,
} from "@weave-order/schema";
import type { PrinterProfile } from "@weave-order/schema";
import { SignJWT, jwtVerify } from "jose";
import { and, asc, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { appendAudit } from "../kernel/audit";
import type { KernelContext } from "../kernel/audit";
import { KernelError } from "../kernel/errors";
import { toIsoOrNull } from "../kernel/mappers";
import { loadEnv } from "../platform/env";
import { PrintError } from "./template-engine";

export const PRINT_AGENT_ISSUER = "weave-order";
export const PRINT_AGENT_AUDIENCE = "print-agent";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function secret(): Uint8Array {
  return new TextEncoder().encode(loadEnv().PRINT_AGENT_SECRET);
}

export class PrintDeviceService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  private mapPrinter(row: typeof printers.$inferSelect): Printer {
    return {
      id: row.id,
      agentId: row.agentId,
      name: row.name,
      kind: row.kind,
      connection: row.connection,
      address: row.address,
      capabilities: row.capabilities,
      calibration: row.calibration,
      status: row.status,
      lastSeenAt: toIsoOrNull(row.lastSeenAt),
    };
  }

  private mapAgent(row: typeof printAgents.$inferSelect, agentPrinters: Printer[]): PrintAgent {
    return {
      id: row.id,
      name: row.name,
      location: row.location,
      status: row.status,
      appVersion: row.appVersion,
      lastSeenAt: toIsoOrNull(row.lastSeenAt),
      printers: agentPrinters,
    };
  }

  /** 注册只返回一次明文 token；库里只有 sha256，token 不能读业务数据。 */
  async register(input: unknown, ctx: KernelContext) {
    const parsed = RegisterPrintAgentInput.parse(input);
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError("PERMISSION_DENIED", "只有人类成员可以注册打印代理");
    }
    const nonce = randomBytes(8).toString("hex");
    const tokenRows = await this.db
      .insert(printAgents)
      .values({
        tenantId: this.tenantId,
        name: parsed.name,
        location: parsed.location ?? null,
        tokenHash: `pending-${nonce}`,
        status: "OFFLINE",
        createdBy: ctx.actor.id,
      })
      .returning();
    const agent = tokenRows[0]!;
    const token = await new SignJWT({ tid: this.tenantId, scope: "print", v: 1 })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(agent.id)
      .setIssuer(PRINT_AGENT_ISSUER)
      .setAudience(PRINT_AGENT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("365d")
      .sign(secret());
    await this.db
      .update(printAgents)
      .set({ tokenHash: hashToken(token) })
      .where(and(eq(printAgents.id, agent.id), eq(printAgents.tenantId, this.tenantId)));
    await appendAudit(
      this.db,
      ctx,
      {
        action: "PRINT_AGENT_REGISTERED",
        entityType: "print_agent",
        entityId: agent.id,
        before: null,
        after: { name: agent.name, location: agent.location },
      },
      this.tenantId,
    );
    return { agent: this.mapAgent(agent, []), token };
  }

  /** 校验 token：签名 + 租户 + 未禁用 + 哈希仍是当前 token（轮换即失效）。 */
  async authenticate(token: string): Promise<{ agentId: string; tenantId: string }> {
    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(token, secret(), {
        issuer: PRINT_AGENT_ISSUER,
        audience: PRINT_AGENT_AUDIENCE,
      });
      payload = verified.payload;
    } catch {
      throw new PrintError("PRINT_AGENT_UNAUTHORIZED", "打印代理 token 无效或已过期");
    }
    if (
      payload.scope !== "print" ||
      payload.tid !== this.tenantId ||
      typeof payload.sub !== "string"
    ) {
      throw new PrintError("PRINT_AGENT_UNAUTHORIZED", "打印代理 token 作用域不正确");
    }
    const rows = await this.db
      .select()
      .from(printAgents)
      .where(and(eq(printAgents.id, payload.sub), eq(printAgents.tenantId, this.tenantId)))
      .limit(1);
    const agent = rows[0];
    if (!agent || agent.disabledAt || agent.tokenHash !== hashToken(token)) {
      throw new PrintError("PRINT_AGENT_UNAUTHORIZED", "打印代理已被禁用或 token 已轮换");
    }
    return { agentId: agent.id, tenantId: this.tenantId };
  }

  async heartbeat(agentId: string, input: unknown): Promise<PrintAgent> {
    const parsed = AgentHeartbeatInput.parse(input);
    const now = new Date();
    const existing = await this.db
      .select()
      .from(printAgents)
      .where(and(eq(printAgents.id, agentId), eq(printAgents.tenantId, this.tenantId)))
      .limit(1);
    if (!existing[0]) {
      throw new PrintError("PRINT_AGENT_UNAUTHORIZED", "打印代理不存在");
    }
    await this.db
      .update(printAgents)
      .set({
        status: "ONLINE",
        lastSeenAt: now,
        appVersion: parsed.appVersion ?? existing[0].appVersion,
      })
      .where(eq(printAgents.id, agentId));
    for (const profile of parsed.printers) {
      await this.upsertPrinter(agentId, profile, now);
    }
    // 心跳里没上报的打印机标记离线，避免 UI 显示「在线但已达不存在」。
    const reported = new Set(parsed.printers.map((printer) => printer.name));
    const current = await this.db
      .select()
      .from(printers)
      .where(and(eq(printers.agentId, agentId), eq(printers.tenantId, this.tenantId)));
    for (const printer of current) {
      if (!reported.has(printer.name) && printer.status !== "OFFLINE") {
        await this.db
          .update(printers)
          .set({ status: "OFFLINE", updatedAt: now })
          .where(eq(printers.id, printer.id));
      }
    }
    return this.getAgent(agentId);
  }

  private async upsertPrinter(agentId: string, profile: PrinterProfile, now: Date): Promise<void> {
    const rows = await this.db
      .select()
      .from(printers)
      .where(
        and(
          eq(printers.tenantId, this.tenantId),
          eq(printers.agentId, agentId),
          eq(printers.name, profile.name),
        ),
      )
      .limit(1);
    if (rows[0]) {
      await this.db
        .update(printers)
        .set({
          kind: profile.kind,
          connection: profile.connection,
          address: profile.address,
          capabilities: profile.capabilities,
          calibration: profile.calibration,
          status: profile.status,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(printers.id, rows[0].id));
      return;
    }
    await this.db.insert(printers).values({
      tenantId: this.tenantId,
      agentId,
      name: profile.name,
      kind: profile.kind,
      connection: profile.connection,
      address: profile.address,
      capabilities: profile.capabilities,
      calibration: profile.calibration,
      status: profile.status,
      lastSeenAt: now,
    });
  }

  async markOnline(agentId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(printAgents)
      .set({ status: "ONLINE", lastSeenAt: now })
      .where(and(eq(printAgents.id, agentId), eq(printAgents.tenantId, this.tenantId)));
  }

  async markOffline(agentId: string): Promise<void> {
    await this.db
      .update(printAgents)
      .set({ status: "OFFLINE", lastSeenAt: new Date() })
      .where(and(eq(printAgents.id, agentId), eq(printAgents.tenantId, this.tenantId)));
  }

  async disable(agentId: string, ctx: KernelContext): Promise<void> {
    const rows = await this.db
      .update(printAgents)
      .set({ status: "DISABLED", disabledAt: new Date() })
      .where(and(eq(printAgents.id, agentId), eq(printAgents.tenantId, this.tenantId)))
      .returning();
    if (!rows[0]) throw new KernelError("RESOURCE_NOT_FOUND", "打印代理不存在");
    await appendAudit(
      this.db,
      ctx,
      {
        action: "PRINT_AGENT_DISABLED",
        entityType: "print_agent",
        entityId: agentId,
        before: { status: rows[0].status },
        after: { status: "DISABLED" },
      },
      this.tenantId,
    );
  }

  async getAgent(agentId: string): Promise<PrintAgent> {
    const rows = await this.db
      .select()
      .from(printAgents)
      .where(and(eq(printAgents.id, agentId), eq(printAgents.tenantId, this.tenantId)))
      .limit(1);
    const agent = rows[0];
    if (!agent) throw new KernelError("RESOURCE_NOT_FOUND", "打印代理不存在");
    const printerRows = await this.db
      .select()
      .from(printers)
      .where(and(eq(printers.agentId, agentId), eq(printers.tenantId, this.tenantId)))
      .orderBy(asc(printers.name));
    return this.mapAgent(
      agent,
      printerRows.map((row) => this.mapPrinter(row)),
    );
  }

  async list() {
    const agentRows = await this.db
      .select()
      .from(printAgents)
      .where(eq(printAgents.tenantId, this.tenantId))
      .orderBy(asc(printAgents.name));
    const printerRows = agentRows.length
      ? await this.db
          .select()
          .from(printers)
          .where(eq(printers.tenantId, this.tenantId))
          .orderBy(asc(printers.name))
      : [];
    const agentPrinters = new Map<string, Printer[]>();
    for (const row of printerRows) {
      const list = agentPrinters.get(row.agentId) ?? [];
      list.push(this.mapPrinter(row));
      agentPrinters.set(row.agentId, list);
    }
    return {
      agents: agentRows.map((row) => this.mapAgent(row, agentPrinters.get(row.id) ?? [])),
      printers: printerRows.map((row) => this.mapPrinter(row)),
    };
  }
}
