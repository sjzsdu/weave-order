import { auditLog, DEFAULT_TENANT_ID } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { AuditLogEntry } from "@weave-order/schema";
import type { AuditAction, DataScope, JsonValue, MemberRole } from "@weave-order/schema";
import { and, desc, eq } from "drizzle-orm";

/** 谁在写账本：智能体 / 人类 / 系统任务。 */
export type ActorType = "AGENT" | "HUMAN" | "SYSTEM";

export interface KernelContext {
  actor: {
    type: ActorType;
    id: string;
    /** 人类成员角色，用于审批金额阈值；缺省按 OWNER 处理（本地/测试兼容）。 */
    role?: MemberRole;
    /** 成员级审批额度（整数分）；null/缺省表示未配置，回落到公司级阈值。 */
    approvalLimitAmount?: number | null;
  };
  /** 同一次业务动作引发的多条审计记录用同一个 correlationId 串起来。 */
  correlationId?: string;
  /** 网关注入的租户；内核调用不传时使用内核绑定的租户（仅演示/测试路径）。 */
  tenantId?: string;
  /** 应用层数据范围；仅 HUMAN 请求由网关注入，缺省 = 不受限（系统 / 智能体内部）。 */
  dataScope?: DataScope;
  /** 归属人 = memberships.id；OWN 范围据此过滤，写入时作为默认负责人。 */
  ownerId?: string | null;
  /** 成员所属团队；TEAM 范围据此取同组负责人。 */
  teamId?: string | null;
}

export interface AuditWrite {
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: JsonValue | null;
  after?: JsonValue | null;
}

/**
 * 在写业务表的同一事务内追加审计记录。
 * 审计写入失败 => 整个事务回滚，账本不会出现「改了但没有记录」的状态。
 *
 * `actor_role` 是动作发生时的角色快照（员工调岗后仍能还原当时权限），
 * 不是指向成员表的引用。迁移 `0007_young_sprite` 之前写入的历史行
 * 该列为 NULL，语义是「升级前未采集角色」，不做猜测性回填。
 */
export async function appendAudit(
  tx: Db | Tx,
  ctx: KernelContext,
  entry: AuditWrite,
  tenantId: string = ctx.tenantId ?? DEFAULT_TENANT_ID,
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    actorRole: ctx.actor.role ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    correlationId: ctx.correlationId ?? null,
  });
}

/** 读取审计日志（最新在前），并用契约 Schema 校验读取模型。可按 entityId 过滤。 */
export async function listAuditLog(
  db: Db,
  limit = 20,
  tenantId: string = DEFAULT_TENANT_ID,
  entityId?: string,
): Promise<AuditLogEntry[]> {
  const conditions = [eq(auditLog.tenantId, tenantId)];
  if (entityId !== undefined) conditions.push(eq(auditLog.entityId, entityId));
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.seq))
    .limit(limit);
  return rows.map((row) =>
    AuditLogEntry.parse({
      id: row.id,
      tenantId: row.tenantId ?? tenantId,
      seq: row.seq,
      actorType: row.actorType,
      actorId: row.actorId,
      actorRole: row.actorRole ?? null,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before ?? null,
      after: row.after ?? null,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString(),
    }),
  );
}
