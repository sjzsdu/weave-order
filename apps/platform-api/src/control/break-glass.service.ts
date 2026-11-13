import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { BreakGlassInput, BreakGlassRequest } from "@weave-order/schema";
import { breakGlassRequests, tenants } from "@weave-order/control-db";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import type { PlatformActor } from "../auth/auth.service";
import { conflict, forbidden, invalid, notFound } from "../domain/errors";
import { loadEnv } from "../env";
import { AuditService } from "./audit.service";
import { toIso } from "./util";

/**
 * Break-glass：控制面永远不持有租户业务数据。
 * 这里只管理「租户同意 + 双人复核 + 60 分钟只读授权」的凭证与审计，
 * 不提供任何读取报价/样品/客户手机号的接口。
 */
@Injectable()
export class BreakGlassService {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: PlatformDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(actor: PlatformActor, raw: unknown): Promise<BreakGlassRequest> {
    const input = BreakGlassInput.parse(raw);
    if (!input.tenantConsent) {
      throw invalid("没有租户管理员同意，只能看账号/账单/用量，不能申请业务数据只读授权");
    }
    const tenantRows = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    if (!tenantRows[0]) throw notFound("租户不存在");

    const rows = await this.db
      .insert(breakGlassRequests)
      .values({
        tenantId: input.tenantId,
        ticketNo: input.ticketNo,
        reason: input.reason,
        tenantConsent: true,
        consentAt: new Date(),
        requestedBy: actor.sub,
        status: "PENDING",
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("break-glass 申请创建失败");

    await this.audit.record(actor, {
      action: "BREAK_GLASS_REQUESTED",
      targetType: "break_glass",
      targetId: row.id,
      after: { tenantId: input.tenantId, ticketNo: input.ticketNo, reason: input.reason },
      reason: input.reason,
    });
    return this.map(row, await this.tenantName(input.tenantId));
  }

  async list(): Promise<BreakGlassRequest[]> {
    await this.expire();
    const rows = await this.db
      .select({ request: breakGlassRequests, tenantName: tenants.name })
      .from(breakGlassRequests)
      .innerJoin(tenants, eq(tenants.id, breakGlassRequests.tenantId))
      .orderBy(desc(breakGlassRequests.createdAt))
      .limit(100);
    return rows.map((row) => this.map(row.request, row.tenantName));
  }

  async get(id: string): Promise<BreakGlassRequest> {
    await this.expire();
    const rows = await this.db
      .select({ request: breakGlassRequests, tenantName: tenants.name })
      .from(breakGlassRequests)
      .innerJoin(tenants, eq(tenants.id, breakGlassRequests.tenantId))
      .where(eq(breakGlassRequests.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("break-glass 申请不存在");
    return this.map(row.request, row.tenantName);
  }

  /** 审批通过后激活：≤60 分钟只读，到期自动收回。 */
  async activate(actor: PlatformActor, id: string): Promise<BreakGlassRequest> {
    const request = await this.getRow(id);
    if (request.status === "ACTIVE") return this.get(id);
    if (request.status !== "PENDING") throw conflict(`申请状态不可激活：${request.status}`);
    if (!request.tenantConsent) throw forbidden("缺少租户同意记录");

    const minutes = loadEnv().PLATFORM_BREAK_GLASS_MINUTES;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.min(minutes, 60) * 60 * 1000);
    await this.db
      .update(breakGlassRequests)
      .set({
        status: "ACTIVE",
        approvedBy: actor.sub,
        startsAt: now,
        expiresAt,
      })
      .where(eq(breakGlassRequests.id, id));

    await this.audit.record(actor, {
      action: "BREAK_GLASS_ACTIVATED",
      targetType: "break_glass",
      targetId: id,
      after: { expiresAt: expiresAt.toISOString(), readOnly: true, minutes: Math.min(minutes, 60) },
      reason: "双人复核通过",
    });
    return this.get(id);
  }

  /**
   * 记录一次只读访问。控制面没有租户业务库连接，所以这里只认授权并留痕，
   * 真正的数据读取必须发生在租户侧（租户审计也会记一条平台支持访问）。
   */
  async recordAccess(actor: PlatformActor, id: string, resource: string) {
    const request = await this.getRow(id);
    if (request.status !== "ACTIVE") throw forbidden(`授权未生效：${request.status}`);
    if (!request.expiresAt || request.expiresAt <= new Date()) {
      await this.db
        .update(breakGlassRequests)
        .set({ status: "EXPIRED" })
        .where(eq(breakGlassRequests.id, id));
      throw forbidden("授权已过期");
    }
    await this.audit.record(actor, {
      action: "BREAK_GLASS_ACCESS",
      targetType: "break_glass",
      targetId: id,
      after: { resource, tenantId: request.tenantId, readOnly: true },
      reason: request.reason,
    });
    return {
      granted: true,
      readOnly: true,
      tenantId: request.tenantId,
      expiresAt: toIso(request.expiresAt),
      note: "控制面不持有业务数据；业务单据读取由租户侧按此授权执行并另行审计",
    };
  }

  async reject(actor: PlatformActor, id: string, reason: string): Promise<BreakGlassRequest> {
    const request = await this.getRow(id);
    if (request.status !== "PENDING") throw conflict("只有待审批申请可以拒绝");
    await this.db
      .update(breakGlassRequests)
      .set({ status: "REJECTED", approvedBy: actor.sub, expiresAt: new Date() })
      .where(eq(breakGlassRequests.id, id));
    await this.audit.record(actor, {
      action: "BREAK_GLASS_REJECTED",
      targetType: "break_glass",
      targetId: id,
      before: { status: request.status },
      after: { status: "REJECTED" },
      reason,
    });
    return this.get(id);
  }

  private async expire(): Promise<void> {
    const rows = await this.db
      .select({ id: breakGlassRequests.id, expiresAt: breakGlassRequests.expiresAt })
      .from(breakGlassRequests)
      .where(eq(breakGlassRequests.status, "ACTIVE"));
    const now = new Date();
    for (const row of rows) {
      if (row.expiresAt && row.expiresAt <= now) {
        await this.db
          .update(breakGlassRequests)
          .set({ status: "EXPIRED" })
          .where(eq(breakGlassRequests.id, row.id));
      }
    }
  }

  private async getRow(id: string): Promise<typeof breakGlassRequests.$inferSelect> {
    const rows = await this.db
      .select()
      .from(breakGlassRequests)
      .where(eq(breakGlassRequests.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("break-glass 申请不存在");
    return row;
  }

  private async tenantName(tenantId: string): Promise<string> {
    const rows = await this.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return rows[0]?.name ?? tenantId;
  }

  private map(row: typeof breakGlassRequests.$inferSelect, tenantName: string): BreakGlassRequest {
    return BreakGlassRequest.parse({
      id: row.id,
      tenantId: row.tenantId,
      tenantName,
      ticketNo: row.ticketNo,
      reason: row.reason,
      status: row.status,
      tenantConsent: row.tenantConsent,
      consentAt: toIso(row.consentAt),
      requestedBy: row.requestedBy,
      approvedBy: row.approvedBy,
      startsAt: toIso(row.startsAt),
      expiresAt: toIso(row.expiresAt),
      createdAt: row.createdAt.toISOString(),
    });
  }
}
