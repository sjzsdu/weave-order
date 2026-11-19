import { auditExportJobs, auditLog, memberships, type Db } from "@weave-order/db";
import {
  AuditExportJob,
  AuditLogDetail,
  AuditLogListItem,
  AuditLogListResponse,
  AuditLogSummary,
  AUDIT_ACTION_LABEL,
  AUDIT_HIGH_RISK_ACTIONS,
  auditActionLabel,
  auditEntityLabel,
  hasCapability,
  isHighRiskAuditAction,
  maskAuditSnapshot,
  memberRoleLabel,
} from "@weave-order/schema";
import type {
  AuditAction,
  AuditLogEntry,
  AuditLogScope,
  AuditLogSummaryRange,
  JsonValue,
  MemberRole,
} from "@weave-order/schema";
import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { memberDisplayName } from "./member-label";
import type { ObjectStorage } from "../platform/storage";

/**
 * 操作日志读取服务（WAN-179）。
 *
 * 与 `kernel.audit`（账本原始读）分工：
 * - `kernel.audit` 继续服务动态流 / 审批卡，参数只有 limit 与 entityId；
 * - 这里提供日志页需要的筛选、keyset 分页、字段级详情、摘要与异步导出。
 *
 * 权限只有一条规则：有 `audit.read.all` 看全公司，否则在服务端强制
 * `actor_id = 自己`。前端永远拿不到「能不能看别人」的开关。
 */

export interface AuditLogQuery {
  from?: Date;
  to?: Date;
  /** 精确匹配 actor_id（成员 id / 智能体 id）。 */
  actorId?: string;
  /** 操作人模糊搜索：同时匹配 actor_id 与姓名快照。 */
  actor?: string;
  actions?: AuditAction[];
  entityType?: string;
  keyword?: string;
  highRisk?: boolean;
  /** 上一页最后一条的 seq。 */
  cursor?: number;
  limit?: number;
}

export interface AuditLogFilterSnapshot {
  from: string | null;
  to: string | null;
  actorId: string | null;
  actor: string | null;
  actions: string[];
  entityType: string | null;
  keyword: string | null;
  highRisk: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EXPORT_PAGE_SIZE = 1000;
const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ViewerCapabilities {
  role?: MemberRole | null;
  /** `audit.read.all` 的判定结果；缺省按能力表从 role 推导。 */
  canReadAll: boolean;
}

export class AuditLogService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly storage: ObjectStorage,
  ) {}

  /** 能力判定只查 `capabilities.ts`，调用点不写角色字符串。 */
  viewerFor(ctx: KernelContext): ViewerCapabilities {
    const role = ctx.actor.role ?? null;
    return {
      role,
      canReadAll: role ? hasCapability(role, "audit.read.all") : false,
    };
  }

  scopeFor(ctx: KernelContext): AuditLogScope {
    return this.viewerFor(ctx).canReadAll ? "ALL" : "OWN";
  }

  async list(query: AuditLogQuery, ctx: KernelContext): Promise<AuditLogListResponse> {
    const scope = this.scopeFor(ctx);
    const limit = clampLimit(query.limit);
    const rows = await this.selectRows(query, ctx, scope, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return AuditLogListResponse.parse({
      scope,
      items: page.map((row) => toListItem(row)),
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.seq : null,
    });
  }

  async detail(seq: number, ctx: KernelContext): Promise<AuditLogDetail> {
    const viewer = this.viewerFor(ctx);
    const scope: AuditLogScope = viewer.canReadAll ? "ALL" : "OWN";
    const conditions: SQL[] = [eq(auditLog.tenantId, this.tenantId), eq(auditLog.seq, seq)];
    if (scope === "OWN") conditions.push(eq(auditLog.actorId, ctx.actor.id));

    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .limit(1);
    const row = rows[0];
    // 越权与不存在返回同一个结果：不泄漏「这条记录存在但你不能看」。
    if (!row) throw new AuditLogNotFoundError(seq);

    const allowCost = viewer.role ? hasCapability(viewer.role, "sample.cost.view") : false;
    const allowPricing = viewer.role
      ? hasCapability(viewer.role, "pricing.cross_person.read")
      : false;
    const before = maskIfPresent(row.before, {
      allowCost,
      allowPricing,
      entityType: row.entityType,
    });
    const after = maskIfPresent(row.after, {
      allowCost,
      allowPricing,
      entityType: row.entityType,
    });

    return AuditLogDetail.parse({
      ...toListItem(row),
      before: before.value,
      after: after.value,
      maskedFields: Array.from(new Set([...before.maskedFields, ...after.maskedFields])).slice(
        0,
        100,
      ),
      correlationId: row.correlationId,
    });
  }

  async summary(range: AuditLogSummaryRange, ctx: KernelContext): Promise<AuditLogSummary> {
    const scope = this.scopeFor(ctx);
    const from = rangeStart(range);
    const conditions = this.scopeConditions(ctx, scope);
    if (from) conditions.push(gte(auditLog.createdAt, from));

    const [totals, days, actors] = await Promise.all([
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          highRisk: sql<number>`count(*) FILTER (WHERE ${auditLog.action} IN ${highRiskInList()})::int`,
        })
        .from(auditLog)
        .where(and(...conditions)),
      this.db
        .select({
          date: sql<string>`to_char(date_trunc('day', ${auditLog.createdAt} AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(auditLog)
        .where(and(...conditions))
        .groupBy(sql`date_trunc('day', ${auditLog.createdAt} AT TIME ZONE 'Asia/Shanghai')`)
        .orderBy(sql`date_trunc('day', ${auditLog.createdAt} AT TIME ZONE 'Asia/Shanghai')`),
      this.db
        .select({ actorType: auditLog.actorType, count: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(and(...conditions))
        .groupBy(auditLog.actorType),
    ]);

    return AuditLogSummary.parse({
      scope,
      range,
      total: totals[0]?.total ?? 0,
      highRiskCount: totals[0]?.highRisk ?? 0,
      days,
      actorTypes: actors,
    });
  }

  /**
   * 建导出任务：只做一次 insert 就返回，CSV 在后台生成。
   * 范围（ALL/OWN）在这里锁定并随 filter 落库，后台任务不会重新判定权限。
   */
  async createExport(query: AuditLogQuery, ctx: KernelContext): Promise<AuditExportJob> {
    // 导出范围 = 审计范围：OWN 角色可以导出，但只能导出自己的记录（后台任务会再套一次范围）。
    const now = new Date();
    // 导出审计不能只剩 UUID：落一份成员展示名快照，离职/改名后仍能看懂是谁导出的。
    const member = await this.db
      .select({ displayName: memberships.displayName, email: memberships.email })
      .from(memberships)
      .where(and(eq(memberships.tenantId, this.tenantId), eq(memberships.subject, ctx.actor.id)))
      .limit(1);
    const requestedByName = memberDisplayName(member[0]?.displayName, member[0]?.email);
    const rows = await this.db
      .insert(auditExportJobs)
      .values({
        tenantId: this.tenantId,
        requestedBy: ctx.actor.id,
        requestedByName,
        requestedByRole: ctx.actor.role ?? null,
        status: "PENDING",
        filter: toFilterSnapshot(query) as unknown as JsonValue,
        fileName: `audit-log-${exportStamp(now)}.csv`,
        expiresAt: new Date(now.getTime() + EXPORT_TTL_MS),
      })
      .returning();
    const job = rows[0];
    if (!job) throw new Error("导出任务创建失败");
    return toExportJob(job, null);
  }

  async exportJob(jobId: string, ctx: KernelContext): Promise<AuditExportJob> {
    const job = await this.loadJob(jobId, ctx);
    let downloadUrl: string | null = null;
    if (job.status === "SUCCEEDED" && job.objectKey) {
      if (job.expiresAt.getTime() <= Date.now()) {
        return toExportJob(job, null, "下载链接已过期，请重新导出");
      }
      downloadUrl = await this.storage.signGet(job.objectKey, 600);
    }
    return toExportJob(job, downloadUrl);
  }

  /**
   * 后台任务：生成 CSV → 写对象存储 → 标记完成 → 写一条 `AUDIT_EXPORTED`。
   *
   * 导出自身只写一条审计（记录导出者、范围、行数），不逐行递归。
   * 失败时把原因落到 job 上，前端能显示「为什么没导出来」，而不是无声卡住。
   */
  async runExport(jobId: string): Promise<void> {
    const job = await this.findJob(jobId);
    if (!job || job.status === "SUCCEEDED") return;

    await this.db
      .update(auditExportJobs)
      .set({ status: "RUNNING", startedAt: new Date() })
      .where(eq(auditExportJobs.id, jobId));

    try {
      const filter = fromFilterSnapshot(job.filter);
      // 导出范围跟随审计范围：JOB 里的 requestedBy 就是创建者，永远只导他能看的。
      const ctx: KernelContext = {
        actor: {
          type: "HUMAN",
          id: job.requestedBy,
          role: (job.requestedByRole as MemberRole | null) ?? undefined,
        },
        tenantId: this.tenantId,
      };
      const scope = this.scopeFor(ctx);
      const csv = await this.buildCsv(filter, ctx, scope);
      const objectKey = `tenant/${this.tenantId}/audit-exports/${job.id}.csv`;
      await this.storage.put(objectKey, Buffer.from(csv, "utf8"), "text/csv; charset=utf-8");
      const rowCount = countCsvRows(csv);

      await this.db
        .update(auditExportJobs)
        .set({ status: "SUCCEEDED", rowCount, objectKey, completedAt: new Date(), error: null })
        .where(eq(auditExportJobs.id, jobId));

      await this.db.transaction(async (tx) => {
        await appendAudit(
          tx,
          ctx,
          {
            action: "AUDIT_EXPORTED",
            entityType: "audit_log",
            entityId: job.id,
            actorName: job.requestedByName ?? null,
            entityLabel: scope === "ALL" ? "全公司操作日志" : "我的操作日志",
            after: { rangeFrom: filter.from, rangeTo: filter.to, rowCount, scope },
          },
          this.tenantId,
        );
      });
    } catch (error) {
      await this.db
        .update(auditExportJobs)
        .set({
          status: "FAILED",
          completedAt: new Date(),
          error: error instanceof Error ? error.message.slice(0, 1000) : "导出失败",
        })
        .where(eq(auditExportJobs.id, jobId));
    }
  }

  private async findJob(jobId: string) {
    const rows = await this.db
      .select()
      .from(auditExportJobs)
      .where(and(eq(auditExportJobs.id, jobId), eq(auditExportJobs.tenantId, this.tenantId)))
      .limit(1);
    return rows[0];
  }

  private async loadJob(jobId: string, ctx: KernelContext) {
    const job = await this.findJob(jobId);
    if (!job) throw new AuditExportNotFoundError(jobId);
    // 只有创建者或能看全公司日志的人可以查看任务与下载。
    if (job.requestedBy !== ctx.actor.id && !this.viewerFor(ctx).canReadAll) {
      throw new AuditExportNotFoundError(jobId);
    }
    return job;
  }

  private scopeConditions(ctx: KernelContext, scope: AuditLogScope): SQL[] {
    const conditions: SQL[] = [eq(auditLog.tenantId, this.tenantId)];
    if (scope === "OWN") conditions.push(eq(auditLog.actorId, ctx.actor.id));
    return conditions;
  }

  private selectRows(
    query: AuditLogQuery,
    ctx: KernelContext,
    scope: AuditLogScope,
    limit: number,
  ) {
    const conditions = this.scopeConditions(ctx, scope);
    if (query.from) conditions.push(gte(auditLog.createdAt, query.from));
    if (query.to) conditions.push(lte(auditLog.createdAt, query.to));
    if (query.actorId) conditions.push(eq(auditLog.actorId, query.actorId));
    if (query.actor) {
      const needle = `%${escapeLike(query.actor)}%`;
      const actorMatch = or(eq(auditLog.actorId, query.actor), ilike(auditLog.actorName, needle));
      if (actorMatch) conditions.push(actorMatch);
    }
    if (query.actions && query.actions.length > 0) {
      conditions.push(inArray(auditLog.action, query.actions));
    }
    if (query.entityType) conditions.push(eq(auditLog.entityType, query.entityType));
    if (query.highRisk) conditions.push(inArray(auditLog.action, [...AUDIT_HIGH_RISK_ACTIONS]));
    if (query.keyword) {
      const keywordMatch = this.keywordCondition(query.keyword);
      if (keywordMatch) conditions.push(keywordMatch);
    }
    if (query.cursor !== undefined) conditions.push(lt(auditLog.seq, query.cursor));

    return this.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.seq))
      .limit(limit);
  }

  /**
   * 关键词同时匹配对象名、操作人姓名、实体 id，以及中文动作名。
   * 动作在库里是英文枚举，用户输入「批准」时要能命中，所以先在文案表里反查。
   */
  private keywordCondition(keyword: string): SQL | undefined {
    const needle = `%${escapeLike(keyword)}%`;
    const parts: SQL[] = [
      ilike(auditLog.entityLabel, needle),
      ilike(auditLog.actorName, needle),
      sql`${auditLog.entityId}::text ILIKE ${needle}`,
    ];
    const actionMatches = Object.entries(AUDIT_ACTION_LABEL)
      .filter(([, label]) => label.includes(keyword))
      .map(([action]) => action as AuditAction);
    if (actionMatches.length > 0) parts.push(inArray(auditLog.action, actionMatches));
    return or(...parts);
  }

  private async buildCsv(
    filter: AuditLogFilterSnapshot,
    ctx: KernelContext,
    scope: AuditLogScope,
  ): Promise<string> {
    const lines = [
      [
        "时间（北京时间）",
        "操作人",
        "当时角色",
        "操作者类型",
        "动作",
        "对象类型",
        "对象",
        "关联ID",
        "变更前",
        "变更后",
      ].join(","),
    ];
    const viewer = this.viewerFor(ctx);
    const allowCost = viewer.role ? hasCapability(viewer.role, "sample.cost.view") : false;
    const allowPricing = viewer.role
      ? hasCapability(viewer.role, "pricing.cross_person.read")
      : false;

    let cursor: number | undefined;
    for (;;) {
      const rows = await this.selectRows(
        {
          from: filter.from ? new Date(filter.from) : undefined,
          to: filter.to ? new Date(filter.to) : undefined,
          actorId: filter.actorId ?? undefined,
          actor: filter.actor ?? undefined,
          actions: filter.actions as AuditAction[],
          entityType: filter.entityType ?? undefined,
          keyword: filter.keyword ?? undefined,
          highRisk: filter.highRisk,
          cursor,
          limit: EXPORT_PAGE_SIZE,
        },
        ctx,
        scope,
        EXPORT_PAGE_SIZE,
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const before = maskIfPresent(row.before, {
          allowCost,
          allowPricing,
          entityType: row.entityType,
        });
        const after = maskIfPresent(row.after, {
          allowCost,
          allowPricing,
          entityType: row.entityType,
        });
        lines.push(
          [
            beijingTime(row.createdAt),
            row.actorName ?? row.actorId,
            row.actorRole ? memberRoleLabel(row.actorRole) : "",
            actorTypeText(row.actorType),
            auditActionLabel(row.action),
            auditEntityLabel(row.entityType),
            row.entityLabel ?? "",
            row.entityId,
            before.value === null ? "" : JSON.stringify(before.value),
            after.value === null ? "" : JSON.stringify(after.value),
          ]
            .map(csvCell)
            .join(","),
        );
      }
      cursor = rows[rows.length - 1]!.seq;
      if (rows.length < EXPORT_PAGE_SIZE) break;
    }
    // BOM：Excel 打开 UTF-8 CSV 不乱码。
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }
}

export class AuditLogNotFoundError extends Error {
  constructor(seq: number) {
    super(`没有找到序号为 ${seq} 的审计记录`);
    this.name = "AuditLogNotFoundError";
  }
}

export class AuditExportNotFoundError extends Error {
  constructor(jobId: string) {
    super(`没有找到导出任务 ${jobId}`);
    this.name = "AuditExportNotFoundError";
  }
}

type AuditRow = typeof auditLog.$inferSelect;
export type AuditExportJobRow = typeof auditExportJobs.$inferSelect;

function clampLimit(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_LIMIT);
}

function toListItem(row: AuditRow): AuditLogListItem {
  const entity = row.entityLabel ?? auditEntityLabel(row.entityType);
  return AuditLogListItem.parse({
    seq: row.seq,
    createdAt: row.createdAt.toISOString(),
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName ?? null,
    actorRole: row.actorRole ?? null,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel ?? null,
    highRisk: isHighRiskAuditAction(row.action),
    summary: `${auditActionLabel(row.action)} · ${entity}`,
  });
}

function toExportJob(
  row: AuditExportJobRow,
  downloadUrl: string | null,
  errorOverride?: string,
): AuditExportJob {
  return AuditExportJob.parse({
    id: row.id,
    status: row.status,
    rowCount: row.rowCount ?? null,
    downloadUrl,
    fileName: row.fileName ?? null,
    error: errorOverride ?? row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
  });
}

function maskIfPresent(
  value: JsonValue | null,
  options: { allowCost: boolean; allowPricing: boolean; entityType: string },
): { value: JsonValue | null; maskedFields: string[] } {
  if (value === null) return { value: null, maskedFields: [] };
  return maskAuditSnapshot(value, options);
}

function rangeStart(range: AuditLogSummaryRange): Date | null {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (range === "7d") return new Date(now - 7 * day);
  if (range === "30d") return new Date(now - 30 * day);
  if (range === "90d") return new Date(now - 90 * day);
  if (range === "12m") return new Date(now - 365 * day);
  return null;
}

function highRiskInList(): SQL {
  const values = AUDIT_HIGH_RISK_ACTIONS.map((action) => sql`${action}`);
  return sql`(${sql.join(values, sql`, `)})`;
}

function toFilterSnapshot(query: AuditLogQuery): AuditLogFilterSnapshot {
  return {
    from: query.from ? query.from.toISOString() : null,
    to: query.to ? query.to.toISOString() : null,
    actorId: query.actorId ?? null,
    actor: query.actor ?? null,
    actions: (query.actions ?? []).map(String),
    entityType: query.entityType ?? null,
    keyword: query.keyword ?? null,
    highRisk: query.highRisk === true,
  };
}

function fromFilterSnapshot(value: JsonValue): AuditLogFilterSnapshot {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    from: typeof record.from === "string" ? record.from : null,
    to: typeof record.to === "string" ? record.to : null,
    actorId: typeof record.actorId === "string" ? record.actorId : null,
    actor: typeof record.actor === "string" ? record.actor : null,
    actions: Array.isArray(record.actions) ? record.actions.map(String) : [],
    entityType: typeof record.entityType === "string" ? record.entityType : null,
    keyword: typeof record.keyword === "string" ? record.keyword : null,
    highRisk: record.highRisk === true,
  };
}

/** LIKE 里的 `%` / `_` 必须转义，否则用户输入 `%` 会扫全表。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function actorTypeText(type: AuditRow["actorType"]): string {
  if (type === "AGENT") return "智能体";
  if (type === "HUMAN") return "人工";
  return "系统";
}

function beijingTime(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function countCsvRows(csv: string): number {
  // 按 RFC 4180 的状态机数记录行：引号内的换行属于单元格内容，不能拆行。
  // 减掉表头行；末尾换行不额外计一行。
  let records = 0;
  let inQuotes = false;
  let hasData = false;
  for (const char of csv.replace(/^\uFEFF/, "")) {
    if (char === '"') {
      inQuotes = !inQuotes;
      hasData = true;
    } else if (!inQuotes && char === "\n") {
      if (hasData) records += 1;
      hasData = false;
    } else if (char !== "\r") {
      hasData = true;
    }
  }
  if (hasData) records += 1;
  return Math.max(records - 1, 0);
}

function exportStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").slice(0, 15);
}

export type { AuditLogEntry };
