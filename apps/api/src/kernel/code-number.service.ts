import { codeCounters, codeRules } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import {
  CODE_ENTITY_MAX_BYTES,
  CodeEntityType,
  CodeRule,
  SaveCodeRuleInput,
  hasCapability,
  codeBucket,
  defaultCodeTemplate,
  previewCodeRule,
  renderCode,
  utf8Bytes,
  validateCodeTemplate,
} from "@weave-order/schema";
import type { CodeRule as CodeRuleValue, CodeRulePreviewResult } from "@weave-order/schema";
import { and, eq, sql } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { isCodeConflict } from "./code-conflict";
import { KernelError } from "./errors";
import { toIso } from "./mappers";

/**
 * 业务编号生成的唯一入口（五类实体共用）。
 *
 * 规则来源：租户在 `code_rules` 的配置；未配置 / 停用 → 回退 classic 预设
 * （客户/样品逐字节等同改造前格式，保证老租户零行为变更）。
 *
 * 并发一致性：按 (tenant, entity, bucket) 的原子计数器 UPSERT 取号，
 * 与业务写入共用调用方事务。唯一索引 `*_tenant_code_idx` 只是最终兜底，
 * 且只有命中本实体的编号唯一索引才由调用方重算（见 code-conflict.ts）。
 *
 * 规则与计数器都不做内存缓存：每单读一次规则，让「改规则立即生效、
 * 不追溯历史」的语义无需处理缓存失效。
 */
export class CodeNumberService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  /** 读取启用规则；无配置 / 停用 → 回退默认模板。 */
  private async activeTemplate(
    tx: Db | Tx,
    entityType: CodeEntityType,
  ): Promise<{ template: string; presetKey: string | null }> {
    const rows = await tx
      .select()
      .from(codeRules)
      .where(
        and(
          eq(codeRules.tenantId, this.tenantId),
          eq(codeRules.entityType, entityType),
          eq(codeRules.enabled, true),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return { template: defaultCodeTemplate(entityType), presetKey: "classic" };
    const parsed = CodeRule.safeParse(mapCodeRuleRow(row));
    if (!parsed.success) {
      // 库里是脏模板时不静默回退：显式报错，避免生成出不合规编号。
      throw new KernelError("KERNEL_REJECTED", `编号规则配置损坏：${entityType}`, {
        reason: "CODE_RULE_CORRUPTED",
      });
    }
    return { template: parsed.data.template, presetKey: parsed.data.presetKey };
  }

  /**
   * 在调用方事务内分配一个编号。
   *
   * 调用方流程（各类实体一致）：
   *   1. 显式传了 code → 不调用本方法，直接写入（显式 code 优先的实体）；
   *   2. 否则在事务内 `await codeNumber.allocate(tx, entityType, now)`；
   *   3. 写入业务表；若撞编号唯一索引 → 回滚整个事务后重试（最多 3 次），
   *      重试判定用 `isCodeConflict(error, entityType)`。
   */
  async allocate(tx: Tx, entityType: CodeEntityType, now: Date = new Date()): Promise<string> {
    const { template } = await this.activeTemplate(tx, entityType);
    const bucket = codeBucket({ entityType, template, now });

    const rows = await tx
      .insert(codeCounters)
      .values({ tenantId: this.tenantId, entityType, bucket, seq: 1 })
      .onConflictDoUpdate({
        target: [codeCounters.tenantId, codeCounters.entityType, codeCounters.bucket],
        set: { seq: sql`${codeCounters.seq} + 1`, updatedAt: new Date() },
      })
      .returning({ seq: codeCounters.seq });

    const seq = rows[0]?.seq;
    if (seq === undefined) {
      throw new KernelError("KERNEL_REJECTED", "编号计数器未返回序号", {
        reason: "CODE_COUNTER_NO_SEQ",
      });
    }
    const code = renderCode({ entityType, template, now, seq });
    const bytes = utf8Bytes(code);
    if (bytes > CODE_ENTITY_MAX_BYTES[entityType]) {
      // 运行时硬校验：n+1 只是容量预算，实际进位后仍可能超限，绝不写库。
      throw new KernelError("KERNEL_REJECTED", `生成编号超出字节上限：${code}（${bytes} 字节）`, {
        reason: "CODE_OVERFLOW",
      });
    }
    return code;
  }

  /**
   * 在调用方事务内「取号 + 写入」的封装，含撞码重试。
   *
   * 关键点：重试必须让计数器推进。若每次 allocate 都 bump 计数器、写入失败就回滚
   * 整个事务，计数器会回退、下次还是同一个号——死循环。因此用 SAVEPOINT：
   *   - allocate（计数器 +1）在 savepoint 之外，撞码回滚不到它；
   *   - 写入在 savepoint 内，撞编号唯一索引时 ROLLBACK TO SAVEPOINT 只撤写入，
   *     计数器的 +1 保留，下一轮自然拿到下一个号。
   * 只有命中本实体编号唯一索引（isCodeConflict）才重试；其他约束原样冒泡。
   */
  async allocateAndWrite<T>(
    tx: Tx,
    entityType: CodeEntityType,
    now: Date,
    write: (code: string) => Promise<T>,
    maxAttempts = 3,
  ): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const code = await this.allocate(tx, entityType, now);
      const sp = `code_alloc_${attempt}`;
      await tx.execute(sql.raw(`SAVEPOINT ${sp}`));
      try {
        const result = await write(code);
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
        return result;
      } catch (error) {
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${sp}`)).catch(() => undefined);
        if (!isCodeConflict(error, entityType)) throw error;
      }
    }
    throw new KernelError("KERNEL_REJECTED", `${entityType} 编号连续冲突，请稍后重试`, {
      reason: "CODE_EXHAUSTED_RETRIES",
    });
  }

  /** 列表：五类实体当前规则（未配置的返回 classic 虚拟项）。 */
  async list(): Promise<CodeRuleValue[]> {
    const rows = await this.db
      .select()
      .from(codeRules)
      .where(eq(codeRules.tenantId, this.tenantId));
    const configured = new Map(rows.map((row) => [row.entityType, row]));
    return CodeEntityType.options.map((entityType) => {
      const row = configured.get(entityType);
      if (row) return CodeRule.parse(mapCodeRuleRow(row));
      // 未落库的虚拟项用零 UUID 表示「尚未配置」，前端按 entityType 索引。
      return CodeRule.parse({
        id: "00000000-0000-0000-0000-000000000000",
        tenantId: this.tenantId,
        entityType,
        template: defaultCodeTemplate(entityType),
        presetKey: "classic",
        enabled: true,
        createdBy: "system",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
    });
  }

  /** 保存规则；先校验模板（复用 schema 纯函数），写审计。 */
  async save(input: SaveCodeRuleInput, ctx: KernelContext): Promise<CodeRuleValue> {
    // 权限只在这里判定（capabilities.ts 是唯一事实源），HTTP 层不复制。
    if (!ctx.actor.role || !hasCapability(ctx.actor.role, "settings.edit")) {
      throw new KernelError("PERMISSION_DENIED", "当前角色没有修改编号规则的权限（需要经理 / 老板）");
    }
    const issues = validateCodeTemplate(input.template, input.entityType);
    if (issues.length > 0) {
      throw new KernelError("KERNEL_REJECTED", `编号模板不合法：${issues[0]?.message ?? ""}`, {
        reason: issues[0]?.code ?? "CODE_TEMPLATE_INVALID",
      });
    }
    const existing = await this.db
      .select()
      .from(codeRules)
      .where(
        and(eq(codeRules.tenantId, this.tenantId), eq(codeRules.entityType, input.entityType)),
      )
      .limit(1);
    const before = existing[0] ? CodeRule.parse(mapCodeRuleRow(existing[0])) : null;
    const actorId = ctx.actor.id || "system";
    const [row] = await this.db
      .insert(codeRules)
      .values({
        tenantId: this.tenantId,
        entityType: input.entityType,
        template: input.template,
        presetKey: input.presetKey ?? null,
        enabled: input.enabled ?? true,
        createdBy: actorId,
      })
      .onConflictDoUpdate({
        target: [codeRules.tenantId, codeRules.entityType],
        set: {
          template: input.template,
          presetKey: input.presetKey ?? null,
          enabled: input.enabled ?? true,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) {
      throw new KernelError("KERNEL_REJECTED", "编号规则保存未返回记录", {
        reason: "CODE_RULE_SAVE_NO_ROW",
      });
    }
    const after = CodeRule.parse(mapCodeRuleRow(row));
    await appendAudit(
      this.db,
      ctx,
      {
        action: "CODE_RULE_SAVED",
        entityType: "code_rule",
        entityId: after.id,
        before: before ? { template: before.template, presetKey: before.presetKey } : null,
        after: { entityType: after.entityType, template: after.template, presetKey: after.presetKey },
      },
      this.tenantId,
    );
    return after;
  }

  /** 恢复为 classic 预设。 */
  async reset(entityType: CodeEntityType, ctx: KernelContext): Promise<CodeRuleValue> {
    return this.save(
      { entityType, template: defaultCodeTemplate(entityType), presetKey: "classic", enabled: true },
      ctx,
    );
  }

  /** 保存前的实时预览（纯计算，不写库、不占号）。 */
  preview(entityType: CodeEntityType, template: string): CodeRulePreviewResult {
    return previewCodeRule({ entityType, template });
  }
}

/** drizzle 行 → 契约值：时间戳从 Date 转 ISO 字符串。 */
function mapCodeRuleRow(row: typeof codeRules.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    entityType: row.entityType,
    template: row.template,
    presetKey: row.presetKey,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}
