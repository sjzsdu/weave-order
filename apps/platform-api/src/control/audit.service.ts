import { Inject, Injectable } from "@nestjs/common";
import type { PlatformAuditEntry } from "@weave-order/schema";
import { PlatformAuditEntry as PlatformAuditSchema } from "@weave-order/schema";
import { and, desc, eq } from "drizzle-orm";
import { platformAudit } from "@weave-order/control-db";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import type { PlatformActor } from "../auth/auth.service";
import { toJson } from "./util";

export interface AuditInput {
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** 平台审计：只追加。数据库触发器会拒绝 UPDATE / DELETE。 */
@Injectable()
export class AuditService {
  constructor(@Inject(PLATFORM_DATABASE) private readonly db: PlatformDb) {}

  async record(actor: PlatformActor, input: AuditInput): Promise<void> {
    await this.db.insert(platformAudit).values({
      actorSub: actor.sub,
      actorName: actor.name,
      actorRole: actor.role,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      before: toJson(input.before),
      after: toJson(input.after),
      reason: input.reason ?? null,
    });
  }

  async list(
    limit = 100,
    filters: { action?: string; targetId?: string } = {},
  ): Promise<PlatformAuditEntry[]> {
    const conditions = [];
    if (filters.action) conditions.push(eq(platformAudit.action, filters.action));
    if (filters.targetId) conditions.push(eq(platformAudit.targetId, filters.targetId));
    const rows = await this.db
      .select()
      .from(platformAudit)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(platformAudit.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map((row) => this.map(row));
  }

  private map(row: typeof platformAudit.$inferSelect): PlatformAuditEntry {
    return PlatformAuditSchema.parse({
      id: row.id,
      actorSub: row.actorSub,
      actorName: row.actorName,
      actorRole: row.actorRole,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      before: row.before ?? null,
      after: row.after ?? null,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    });
  }
}
