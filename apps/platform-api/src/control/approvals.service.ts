import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import { PlatformApprovalDecisionInput, ApprovalRequest } from "@weave-order/schema";
import type { ApprovalAction, ApprovalVote, PlatformRole } from "@weave-order/schema";
import { approvals } from "@weave-order/control-db";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import type { PlatformActor } from "../auth/auth.service";
import { conflict, forbidden, notFound } from "../domain/errors";
import { loadEnv } from "../env";
import { ActionExecutorService } from "./action-executor.service";
import { AuditService } from "./audit.service";
import { toJson } from "./util";

export interface CreateApprovalArgs {
  action: ApprovalAction;
  targetType: string;
  targetId?: string | null;
  summary: string;
  payload: Record<string, unknown>;
  reason: string;
  requiredRoles?: PlatformRole[];
}

/**
 * 双人复核：请求人不能自己批准；必须覆盖全部必需角色且至少两名不同的人。
 * 复核通过后由 ActionExecutor 执行，并把结果写回审批记录与平台审计。
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: PlatformDb,
    @Inject(ActionExecutorService) private readonly executor: ActionExecutorService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(actor: PlatformActor, args: CreateApprovalArgs): Promise<ApprovalRequest> {
    const requiredRoles = args.requiredRoles ?? this.executor.requiredRoles(args.action);
    const ttl = loadEnv().PLATFORM_APPROVAL_TTL_MINUTES;
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

    const requesterVotes = requiredRoles.includes(actor.role)
      ? [{ subject: actor.sub, name: actor.name, role: actor.role, at: new Date().toISOString() }]
      : [];

    const rows = await this.db
      .insert(approvals)
      .values({
        action: args.action,
        targetType: args.targetType,
        targetId: args.targetId ?? null,
        summary: args.summary,
        payload: toJson(args.payload) as Record<string, never>,
        requiredRoles,
        votes: requesterVotes,
        requestedBy: actor.sub,
        requestedByName: actor.name,
        reason: args.reason,
        expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("审批创建失败");

    await this.audit.record(actor, {
      action: "APPROVAL_REQUESTED",
      targetType: args.targetType,
      targetId: args.targetId ?? null,
      after: { approvalId: row.id, action: args.action, requiredRoles, reason: args.reason },
      reason: args.reason,
    });
    return this.map(row);
  }

  async list(status?: string): Promise<ApprovalRequest[]> {
    await this.expireStale();
    const rows = await this.db
      .select()
      .from(approvals)
      .where(status ? eq(approvals.status, status as never) : undefined)
      .orderBy(desc(approvals.createdAt))
      .limit(200);
    return rows.map((row) => this.map(row));
  }

  async get(id: string): Promise<ApprovalRequest> {
    const rows = await this.db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound("审批请求不存在");
    return this.map(row);
  }

  async decide(actor: PlatformActor, id: string, raw: unknown): Promise<ApprovalRequest> {
    const input = PlatformApprovalDecisionInput.parse(raw);
    const row = await this.getRow(id);
    const requiredRoles = row.requiredRoles as PlatformRole[];
    if (row.status !== "PENDING") throw conflict(`审批已结束：${row.status}`);
    if (new Date() > row.expiresAt) {
      await this.db.update(approvals).set({ status: "EXPIRED" }).where(eq(approvals.id, id));
      throw conflict("审批已过期，请重新发起");
    }
    if (row.requestedBy === actor.sub) throw forbidden("双人复核：发起人不能批准自己的申请");
    if (!row.requiredRoles.includes(actor.role)) {
      throw forbidden(`该审批需要角色 ${row.requiredRoles.join(" / ")} 复核`);
    }
    const votes = (row.votes as ApprovalVote[]) ?? [];
    if (votes.some((vote) => vote.subject === actor.sub)) throw conflict("你已经投过票");

    if (input.decision === "reject") {
      const updated = await this.db
        .update(approvals)
        .set({
          status: "REJECTED",
          votes: [...votes, voteOf(actor)],
          decidedAt: new Date(),
          result: toJson({ rejectedBy: actor.sub, reason: input.reason ?? null }) as Record<
            string,
            never
          >,
        })
        .where(eq(approvals.id, id))
        .returning();
      await this.audit.record(actor, {
        action: "APPROVAL_REJECTED",
        targetType: row.targetType,
        targetId: row.targetId,
        after: { approvalId: id, action: row.action, reason: input.reason ?? null },
        reason: input.reason ?? "复核拒绝",
      });
      return this.map(required(updated[0]));
    }

    const nextVotes = [...votes, voteOf(actor)];
    const coveredRoles = new Set(nextVotes.map((vote) => vote.role));
    const distinctActors = new Set(nextVotes.map((vote) => vote.subject));
    const ready = requiredRoles.every((role) => coveredRoles.has(role)) && distinctActors.size >= 2;

    if (!ready) {
      const updated = await this.db
        .update(approvals)
        .set({ votes: nextVotes })
        .where(eq(approvals.id, id))
        .returning();
      await this.audit.record(actor, {
        action: "APPROVAL_VOTED",
        targetType: row.targetType,
        targetId: row.targetId,
        after: {
          approvalId: id,
          approved: true,
          pendingRoles: missingRoles(requiredRoles, coveredRoles),
        },
        reason: "双人复核第一票",
      });
      return this.map(required(updated[0]));
    }

    const result = await this.executor.execute(actor, row.action, row.payload);
    const updated = await this.db
      .update(approvals)
      .set({
        status: "EXECUTED",
        votes: nextVotes,
        decidedAt: new Date(),
        result: result,
      })
      .where(eq(approvals.id, id))
      .returning();
    await this.audit.record(actor, {
      action: "APPROVAL_EXECUTED",
      targetType: row.targetType,
      targetId: row.targetId,
      after: { approvalId: id, action: row.action, result },
      reason: "双人复核通过并执行",
    });
    return this.map(required(updated[0]));
  }

  private async expireStale(): Promise<void> {
    await this.db
      .update(approvals)
      .set({ status: "EXPIRED" })
      .where(and(eq(approvals.status, "PENDING"), lt(approvals.expiresAt, new Date())));
  }

  private async getRow(id: string): Promise<typeof approvals.$inferSelect> {
    const rows = await this.db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound("审批请求不存在");
    return row;
  }

  private map(row: typeof approvals.$inferSelect): ApprovalRequest {
    return ApprovalRequest.parse({
      id: row.id,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      summary: row.summary,
      payload: row.payload,
      requiredRoles: row.requiredRoles,
      votes: row.votes,
      status: row.status,
      requestedBy: row.requestedBy,
      requestedByName: row.requestedByName,
      reason: row.reason,
      expiresAt: row.expiresAt.toISOString(),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      result: row.result,
      createdAt: row.createdAt.toISOString(),
    });
  }
}

function voteOf(actor: PlatformActor) {
  return { subject: actor.sub, name: actor.name, role: actor.role, at: new Date().toISOString() };
}

function missingRoles(required: PlatformRole[], covered: Set<PlatformRole>): PlatformRole[] {
  return required.filter((role) => !covered.has(role));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("审批写入失败");
  return value;
}
