import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { SupportTicketInput, TicketStatusInput } from "@weave-order/schema";
import type { SupportTicket } from "@weave-order/schema";
import { supportTickets, tenants } from "@weave-order/control-db";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import type { PlatformActor } from "../auth/auth.service";
import { notFound } from "../domain/errors";
import { AuditService } from "./audit.service";

@Injectable()
export class SupportService {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: PlatformDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(): Promise<SupportTicket[]> {
    const rows = await this.db
      .select({ ticket: supportTickets, tenantName: tenants.name })
      .from(supportTickets)
      .innerJoin(tenants, eq(tenants.id, supportTickets.tenantId))
      .orderBy(desc(supportTickets.createdAt))
      .limit(200);
    return rows.map((row) => mapTicket(row.ticket, row.tenantName));
  }

  async create(actor: PlatformActor, raw: unknown): Promise<SupportTicket> {
    const input = SupportTicketInput.parse(raw);
    const tenant = await this.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    if (!tenant[0]) throw notFound("租户不存在");
    const rows = await this.db
      .insert(supportTickets)
      .values({
        tenantId: input.tenantId,
        title: input.title,
        body: input.body,
        priority: input.priority,
        createdBy: actor.sub,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("工单创建失败");
    await this.audit.record(actor, {
      action: "SUPPORT_TICKET_OPENED",
      targetType: "support_ticket",
      targetId: row.id,
      after: { tenantId: input.tenantId, title: input.title, priority: input.priority },
      reason: "平台开工单",
    });
    return mapTicket(row, tenant[0].name);
  }

  async updateStatus(actor: PlatformActor, id: string, raw: unknown): Promise<SupportTicket> {
    const input = TicketStatusInput.parse(raw);
    const current = await this.db
      .select({ ticket: supportTickets, tenantName: tenants.name })
      .from(supportTickets)
      .innerJoin(tenants, eq(tenants.id, supportTickets.tenantId))
      .where(eq(supportTickets.id, id))
      .limit(1);
    if (!current[0]) throw notFound("工单不存在");
    const rows = await this.db
      .update(supportTickets)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(supportTickets.id, id))
      .returning();
    await this.audit.record(actor, {
      action: "SUPPORT_TICKET_UPDATED",
      targetType: "support_ticket",
      targetId: id,
      before: { status: current[0].ticket.status },
      after: { status: input.status },
      reason: "更新工单状态",
    });
    return mapTicket(rows[0] ?? current[0].ticket, current[0].tenantName);
  }
}

function mapTicket(row: typeof supportTickets.$inferSelect, tenantName: string): SupportTicket {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantName,
    title: row.title,
    body: row.body,
    priority: row.priority as SupportTicket["priority"],
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
