import { customerContacts, customers, fieldOptions, samples } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import {
  CompositionParts,
  DEFAULT_FIELD_OPTIONS,
  FieldKey,
  FieldOption,
  FieldOptionMergePreview,
  MergeFieldOptionsInput,
  MergeFieldOptionsResult,
  ReorderFieldOptionsInput,
  RenameFieldOptionInput,
  CreateFieldOptionInput,
  compositionText,
  generateOptionCode,
  generateTierCode,
  hasCapability,
  mergeCompositionParts,
  normalizeFieldValue,
  resolveFieldValue,
} from "@weave-order/schema";
import type { FieldResolution, FieldOptionWithUsage, JsonValue } from "@weave-order/schema";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation } from "./errors";
import { toIso } from "./mappers";

type FieldOptionRow = typeof fieldOptions.$inferSelect;

function mapOption(row: FieldOptionRow): FieldOption {
  return {
    id: row.id,
    tenantId: row.tenantId,
    fieldKey: row.fieldKey as FieldKey,
    code: row.code,
    label: row.label,
    normalized: row.normalized,
    sortOrder: row.sortOrder,
    active: row.active,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/** 存原文的样品字段 → 物理列；等级/联系人角色不走这里。 */
function sampleTextColumn(fieldKey: string) {
  if (fieldKey === "sample.category") return samples.category;
  if (fieldKey === "sample.composition") return samples.composition;
  if (fieldKey === "sample.color") return samples.color;
  return null;
}

/** 新租户的预置选项：与迁移 0025 存量补种共用同一份 `DEFAULT_FIELD_OPTIONS`。 */
export async function seedFieldOptions(tx: Tx | Db, tenantId: string): Promise<void> {
  const values = Object.entries(DEFAULT_FIELD_OPTIONS).flatMap(([fieldKey, presets]) =>
    presets.map((preset) => ({
      tenantId,
      fieldKey,
      code: preset.code,
      label: preset.label,
      normalized: normalizeFieldValue(preset.label),
      sortOrder: preset.sortOrder,
    })),
  );
  if (values.length === 0) return;
  await tx.insert(fieldOptions).values(values).onConflictDoNothing();
}

/**
 * 字段选项内核服务：客户等级 / 样品品类 / 样品成分 / 联系人角色共用一套 CRUD。
 *
 * 语义边界（WAN-174 巧匠修订）：
 * - 改名只改建议名，不回写任何业务表。等级因为业务表存 code，历史客户自动显示新名；
 *   品类/成分存原文，历史保持原话。
 * - 删除一律软删除，历史仍可解析 label，下拉不再出现。
 * - 合并是唯一回写业务数据的操作，必须先预览条数 + 样例，再在单事务里改写并审计。
 * - 每个写操作都写一条 `FIELD_OPTION_*` 审计，与业务写入同事务。
 */
export class FieldOptionsService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async list(fieldKey: FieldKey, includeInactive = false): Promise<FieldOption[]> {
    const rows = await this.db
      .select()
      .from(fieldOptions)
      .where(
        and(
          eq(fieldOptions.tenantId, this.tenantId),
          eq(fieldOptions.fieldKey, fieldKey),
          includeInactive ? undefined : eq(fieldOptions.active, true),
        ),
      )
      .orderBy(asc(fieldOptions.sortOrder), asc(fieldOptions.createdAt));
    return rows.map(mapOption);
  }

  /** 治理页/设置页：全部选项（含已停用）+ 实际用量。 */
  async listWithUsage(fieldKey: FieldKey): Promise<FieldOptionWithUsage[]> {
    const options = await this.list(fieldKey, true);
    const usage = await this.usageByNormalized(fieldKey, options);
    return options.map((option) => ({
      ...option,
      usage: usage.get(this.usageKey(fieldKey, option)) ?? 0,
    }));
  }

  async create(input: unknown, ctx: KernelContext): Promise<FieldOption> {
    this.ensureManage(ctx);
    const parsed = CreateFieldOptionInput.parse(input);
    const normalized = normalizeFieldValue(parsed.label);
    const code = parsed.fieldKey === "customer.tier" ? generateTierCode() : generateOptionCode();

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(fieldOptions)
        .values({
          tenantId: this.tenantId,
          fieldKey: parsed.fieldKey,
          code,
          label: parsed.label,
          normalized,
          sortOrder: await this.nextSortOrder(tx, parsed.fieldKey),
        })
        .onConflictDoNothing()
        .returning();
      const created = inserted[0];
      if (created) {
        await this.audit(tx, ctx, "FIELD_OPTION_CREATED", created, null, {
          fieldKey: created.fieldKey,
          code: created.code,
          label: created.label,
        });
        return mapOption(created);
      }

      // 并发同名：唯一约束让后到者落到已有行，直接复用，不返回 409。
      const existing = await tx
        .select()
        .from(fieldOptions)
        .where(
          and(
            eq(fieldOptions.tenantId, this.tenantId),
            eq(fieldOptions.fieldKey, parsed.fieldKey),
            eq(fieldOptions.normalized, normalized),
          ),
        )
        .limit(1);
      const row = existing[0];
      if (!row) {
        throw new KernelError("KERNEL_REJECTED", "选项写入冲突，请重试", {
          reason: "FIELD_OPTION_CONFLICT",
        });
      }
      // 同名的已停用选项被重新使用：恢复而不是暗示「这是新选项」。
      if (!row.active) {
        const revived = await tx
          .update(fieldOptions)
          .set({ active: true, updatedAt: new Date() })
          .where(eq(fieldOptions.id, row.id))
          .returning();
        const back = revived[0] ?? row;
        await this.audit(
          tx,
          ctx,
          "FIELD_OPTION_CREATED",
          back,
          { active: false },
          {
            fieldKey: back.fieldKey,
            code: back.code,
            label: back.label,
            revived: true,
          },
        );
        return mapOption(back);
      }
      return mapOption(row);
    });
  }

  /** 改名：只改 label，不碰业务表。 */
  async rename(id: string, input: unknown, ctx: KernelContext): Promise<FieldOption> {
    this.ensureManage(ctx);
    const parsed = RenameFieldOptionInput.parse(input);
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.requireRow(tx, id);
        const updated = await tx
          .update(fieldOptions)
          .set({
            label: parsed.label,
            normalized: normalizeFieldValue(parsed.label),
            updatedAt: new Date(),
          })
          .where(eq(fieldOptions.id, id))
          .returning();
        const next = updated[0];
        if (!next) throw this.notFound(id);
        await this.audit(
          tx,
          ctx,
          "FIELD_OPTION_UPDATED",
          next,
          { label: row.label },
          {
            label: next.label,
          },
        );
        return mapOption(next);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `已经有「${parsed.label}」这个选项了，可以改为合并到它`,
          { reason: "FIELD_OPTION_LABEL_EXISTS" },
        );
      }
      throw error;
    }
  }

  /** 软删除：历史仍可解析 label，下拉不再出现；可随时恢复。 */
  async remove(id: string, ctx: KernelContext): Promise<void> {
    this.ensureManage(ctx);
    await this.db.transaction(async (tx) => {
      const row = await this.requireRow(tx, id);
      if (!row.active) return;
      await tx
        .update(fieldOptions)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(fieldOptions.id, id));
      await this.audit(
        tx,
        ctx,
        "FIELD_OPTION_DELETED",
        row,
        { active: true },
        {
          active: false,
          label: row.label,
        },
      );
    });
  }

  async restore(id: string, ctx: KernelContext): Promise<FieldOption> {
    this.ensureManage(ctx);
    return this.db.transaction(async (tx) => {
      const row = await this.requireRow(tx, id);
      if (row.active) return mapOption(row);
      const updated = await tx
        .update(fieldOptions)
        .set({ active: true, updatedAt: new Date() })
        .where(eq(fieldOptions.id, id))
        .returning();
      const next = updated[0];
      if (!next) throw this.notFound(id);
      await this.audit(
        tx,
        ctx,
        "FIELD_OPTION_UPDATED",
        next,
        { active: false },
        {
          active: true,
          label: next.label,
        },
      );
      return mapOption(next);
    });
  }

  /** 全量排序：必须覆盖该字段全部选项，避免半截顺序把未传的行挤到最前。 */
  async reorder(input: unknown, ctx: KernelContext): Promise<FieldOption[]> {
    this.ensureManage(ctx);
    const parsed = ReorderFieldOptionsInput.parse(input);
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(fieldOptions)
        .where(
          and(eq(fieldOptions.tenantId, this.tenantId), eq(fieldOptions.fieldKey, parsed.fieldKey)),
        );
      const known = new Set(rows.map((row) => row.id));
      const seen = new Set<string>();
      for (const id of parsed.ids) {
        if (!known.has(id) || seen.has(id)) {
          throw new KernelError("KERNEL_REJECTED", "排序列表与现有选项不一致，请刷新后重试", {
            reason: "FIELD_OPTION_REORDER_MISMATCH",
          });
        }
        seen.add(id);
      }
      if (seen.size !== known.size) {
        throw new KernelError("KERNEL_REJECTED", "排序需要包含全部选项，请刷新后重试", {
          reason: "FIELD_OPTION_REORDER_MISMATCH",
        });
      }
      for (const [index, id] of parsed.ids.entries()) {
        await tx
          .update(fieldOptions)
          .set({ sortOrder: (index + 1) * 10, updatedAt: new Date() })
          .where(eq(fieldOptions.id, id));
      }
      const anchor = rows[0];
      if (anchor) {
        await this.audit(tx, ctx, "FIELD_OPTION_REORDERED", anchor, null, {
          fieldKey: anchor.fieldKey,
          ids: parsed.ids,
        });
      }
      return this.list(parsed.fieldKey, true);
    });
  }

  /** 合并预览：读路径，不改数据。 */
  async previewMerge(sourceId: string, targetId: string): Promise<FieldOptionMergePreview> {
    const [sourceRow, targetRow] = await Promise.all([
      this.getRow(sourceId),
      this.getRow(targetId),
    ]);
    this.ensureMergeable(sourceRow, targetRow);
    const impact = await this.mergeImpact(sourceRow);
    return FieldOptionMergePreview.parse({
      fieldKey: sourceRow.fieldKey,
      source: mapOption(sourceRow),
      target: mapOption(targetRow),
      affected: impact.affected,
      samples: impact.samples,
    });
  }

  async merge(input: unknown, ctx: KernelContext): Promise<{ affected: number }> {
    this.ensureManage(ctx);
    const parsed = MergeFieldOptionsInput.parse(input);
    return this.db.transaction(async (tx) => {
      const source = await this.requireRow(tx, parsed.sourceId);
      const target = await this.requireRow(tx, parsed.targetId);
      this.ensureMergeable(source, target);

      let affected = 0;
      if (source.fieldKey === "customer.tier") {
        const rows = await tx
          .update(customers)
          .set({ tier: target.code })
          .where(and(eq(customers.tenantId, this.tenantId), eq(customers.tier, source.code)))
          .returning({ id: customers.id });
        affected = rows.length;
      } else if (source.fieldKey === "sample.material") {
        affected = parsed.rewriteText
          ? await this.rewriteMaterialParts(tx, source, target)
          : (await this.mergeImpact(source)).affected;
      } else if (parsed.rewriteText) {
        affected = await this.rewriteTextValues(tx, source, target.label);
      } else {
        affected = (await this.mergeImpact(source)).affected;
      }

      await tx
        .update(fieldOptions)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(fieldOptions.id, source.id));
      await this.audit(
        tx,
        ctx,
        "FIELD_OPTION_MERGED",
        source,
        {
          source: { code: source.code, label: source.label },
          target: { code: target.code, label: target.label },
        },
        { affected, rewriteText: parsed.rewriteText },
      );
      return MergeFieldOptionsResult.parse({ affected });
    });
  }

  /** 导入/智能体共用解析：只按归一化精确匹配，不做模糊。 */
  async resolve(
    fieldKey: FieldKey,
    value: string,
    includeInactive = false,
  ): Promise<FieldResolution> {
    const options = await this.list(fieldKey, includeInactive);
    return resolveFieldValue(
      fieldKey,
      value,
      options.map((option) => ({
        fieldKey: option.fieldKey,
        code: option.code,
        label: option.label,
        normalized: option.normalized,
        active: option.active,
      })),
      includeInactive,
    );
  }

  /**
   * 等级写入的唯一闸门：必须解析到已有 code。
   *
   * 列已经从 enum 放宽成 varchar，若不在这里收口，导入/API/智能体都能写下
   * 悬挂 code，历史客户会显示成原始字符串。智能体尤其不能自己发明等级。
   */
  async resolveTierCode(value: string, ctx?: KernelContext): Promise<string> {
    // 自愈：只存在于测试/历史数据的「没有任何选项」租户，在建客户前补一份预置项。
    // 判据是整表为空，不是某个字段为空——用户主动删光等级时不应被悄悄复活。
    const existing = await this.db
      .select({ id: fieldOptions.id })
      .from(fieldOptions)
      .where(eq(fieldOptions.tenantId, this.tenantId))
      .limit(1);
    if (existing.length === 0) await seedFieldOptions(this.db, this.tenantId);
    const resolution = await this.resolve("customer.tier", value, true);
    if (resolution.code) return resolution.code;
    if (ctx?.actor.type === "AGENT") {
      throw new KernelError("KERNEL_REJECTED", `新等级待确认：${value}`, {
        reason: "FIELD_OPTION_UNRESOLVED_TIER",
      });
    }
    throw new KernelError("KERNEL_REJECTED", `未知等级：${value}，请先创建或映射到已有等级`, {
      reason: "FIELD_OPTION_UNRESOLVED_TIER",
    });
  }

  private ensureManage(ctx: KernelContext): void {
    if (!ctx.actor.role || !hasCapability(ctx.actor.role, "field_options.manage")) {
      throw new KernelError("PERMISSION_DENIED", "当前角色不能管理字段选项", {
        reason: "FIELD_OPTION_MANAGE_DENIED",
      });
    }
  }

  private ensureMergeable(source: FieldOptionRow, target: FieldOptionRow): void {
    if (source.id === target.id) {
      throw new KernelError("KERNEL_REJECTED", "不能合并到选项自己", {
        reason: "FIELD_OPTION_MERGE_SELF",
      });
    }
    if (source.fieldKey !== target.fieldKey) {
      throw new KernelError("KERNEL_REJECTED", "只能合并同一字段下的选项", {
        reason: "FIELD_OPTION_MERGE_FIELD_MISMATCH",
      });
    }
    if (!target.active) {
      throw new KernelError("KERNEL_REJECTED", "目标选项已停用，请先恢复", {
        reason: "FIELD_OPTION_MERGE_TARGET_INACTIVE",
      });
    }
  }

  private usageKey(fieldKey: FieldKey, option: FieldOption | FieldOptionRow): string {
    // 等级与原料按 code 记用量：原料在配比里是以 code 引用的，
    // 按名称统计会漏掉「同一原料两个叫法」的历史数据。
    if (fieldKey === "customer.tier" || fieldKey === "sample.material") {
      return `code:${option.code}`;
    }
    return `n:${option.normalized}`;
  }

  private async usageByNormalized(
    fieldKey: FieldKey,
    options: Array<FieldOption | FieldOptionRow>,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (fieldKey === "customer.tier") {
      const rows = await this.db
        .select({ code: customers.tier, total: count() })
        .from(customers)
        .where(eq(customers.tenantId, this.tenantId))
        .groupBy(customers.tier);
      const byCode = new Map(rows.map((row) => [row.code, Number(row.total)]));
      for (const option of options) {
        result.set(this.usageKey(fieldKey, option), byCode.get(option.code) ?? 0);
      }
      return result;
    }
    if (fieldKey === "contact.role") {
      // 联系人角色存原文（label），按归一化后的值统计在用的联系人行。
      const rows = await this.db
        .select({ value: customerContacts.role, total: count() })
        .from(customerContacts)
        .where(
          and(
            eq(customerContacts.tenantId, this.tenantId),
            sql`${customerContacts.role} is not null`,
            sql`${customerContacts.archivedAt} is null`,
          ),
        )
        .groupBy(customerContacts.role);
      for (const option of options) {
        let total = 0;
        for (const row of rows) {
          if (row.value && normalizeFieldValue(row.value) === option.normalized) {
            total += Number(row.total);
          }
        }
        result.set(this.usageKey(fieldKey, option), total);
      }
      return result;
    }
    if (fieldKey === "sample.material") {
      // 原料用量 = 含这个原料 code 的样品数；配比存在 jsonb 里，按 code 扫一遍。
      const rows = await this.materialUsageCounts();
      for (const option of options) {
        result.set(this.usageKey(fieldKey, option), rows.get(option.code) ?? 0);
      }
      return result;
    }
    const counts = await this.textValueCounts(fieldKey);
    for (const option of options) {
      let total = 0;
      for (const entry of counts) {
        if (normalizeFieldValue(entry.value) === option.normalized) total += entry.total;
      }
      result.set(this.usageKey(fieldKey, option), total);
    }
    return result;
  }

  /** 每个原料 code 被多少个样品的配比引用。 */
  private async materialUsageCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ parts: samples.compositionParts })
      .from(samples)
      .where(and(eq(samples.tenantId, this.tenantId), sql`${samples.compositionParts} is not null`));
    const counts = new Map<string, number>();
    for (const row of rows) {
      const parts = row.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const code = (part as { code?: unknown } | null)?.code;
        if (typeof code !== "string") continue;
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** 纯文本字段按原文分组计数；归一化在应用层做，与表单/导入/智能体共用同一函数。 */
  private async textValueCounts(
    fieldKey: string,
  ): Promise<Array<{ value: string; total: number }>> {
    const column = sampleTextColumn(fieldKey);
    if (!column) return [];
    return this.groupSamples(column);
  }

  private async groupSamples(
    column: typeof samples.category | typeof samples.composition | typeof samples.color,
  ): Promise<Array<{ value: string; total: number }>> {
    const rows = await this.db
      .select({ value: column, total: count() })
      .from(samples)
      .where(and(eq(samples.tenantId, this.tenantId), sql`${column} is not null`))
      .groupBy(column);
    return rows
      .filter((row): row is { value: string; total: number } => typeof row.value === "string")
      .map((row) => ({ value: row.value, total: Number(row.total) }));
  }

  private async mergeImpact(
    source: FieldOptionRow,
  ): Promise<{ affected: number; samples: Array<{ id: string; label: string }> }> {
    if (source.fieldKey === "customer.tier") {
      const [aggregate, rows] = await Promise.all([
        this.db
          .select({ total: count() })
          .from(customers)
          .where(and(eq(customers.tenantId, this.tenantId), eq(customers.tier, source.code))),
        this.db
          .select({ id: customers.id, code: customers.code, name: customers.name })
          .from(customers)
          .where(and(eq(customers.tenantId, this.tenantId), eq(customers.tier, source.code)))
          .limit(5),
      ]);
      return {
        affected: Number(aggregate[0]?.total ?? 0),
        samples: rows.map((row) => ({ id: row.id, label: `${row.code} · ${row.name}` })),
      };
    }
    const column = sampleTextColumn(source.fieldKey);
    if (source.fieldKey === "sample.material") {
      // 原料用量按 code 统计：配比里引用的就是 code。
      const counts = await this.materialUsageCounts();
      const affected = counts.get(source.code) ?? 0;
      if (affected === 0) return { affected: 0, samples: [] };
      const rows = await this.db
        .select({ id: samples.id, code: samples.code, name: samples.name })
        .from(samples)
        .where(
          and(
            eq(samples.tenantId, this.tenantId),
            sql`${samples.compositionParts} @> ${JSON.stringify([{ code: source.code }])}::jsonb`,
          ),
        )
        .limit(5);
      return {
        affected,
        samples: rows.map((row) => ({ id: row.id, label: `${row.code} · ${row.name}` })),
      };
    }
    if (column) {
      const counts = await this.textValueCounts(source.fieldKey);
      const matched = counts
        .filter((entry) => normalizeFieldValue(entry.value) === source.normalized)
        .map((entry) => entry.value);
      const affected = counts
        .filter((entry) => normalizeFieldValue(entry.value) === source.normalized)
        .reduce((sum, entry) => sum + entry.total, 0);
      if (matched.length === 0) return { affected: 0, samples: [] };
      const rows = await this.db
        .select({ id: samples.id, code: samples.code, name: samples.name })
        .from(samples)
        .where(and(eq(samples.tenantId, this.tenantId), inArray(column, matched)))
        .limit(5);
      return {
        affected,
        samples: rows.map((row) => ({ id: row.id, label: `${row.code} · ${row.name}` })),
      };
    }
    return { affected: 0, samples: [] };
  }

  /**
   * 原料合并：把配比里的源原料换成目标原料，并重算成分文本。
   *
   * 文本是配比派生出来的，所以改配比必须同步改文本 —— 否则样卡上印的还是旧比例。
   */
  private async rewriteMaterialParts(
    tx: Tx,
    source: FieldOptionRow,
    target: FieldOptionRow,
  ): Promise<number> {
    const rows = await tx
      .select({ id: samples.id, parts: samples.compositionParts })
      .from(samples)
      .where(and(eq(samples.tenantId, this.tenantId), sql`${samples.compositionParts} is not null`));
    let affected = 0;
    for (const row of rows) {
      const parts = row.parts;
      if (!Array.isArray(parts)) continue;
      const parsed = CompositionParts.safeParse(parts);
      if (!parsed.success) continue;
      if (!parsed.data.some((part) => part.code === source.code)) continue;
      const merged = mergeCompositionParts(parsed.data, source.code, {
        code: target.code,
        label: target.label,
      });
      await tx
        .update(samples)
        .set({ compositionParts: merged, composition: compositionText(merged) })
        .where(eq(samples.id, row.id));
      affected += 1;
    }
    return affected;
  }

  /** 把按归一化命中的原文值逐值改成目标 label；只碰匹配的行。 */
  private async rewriteTextValues(
    tx: Tx,
    source: FieldOptionRow,
    targetLabel: string,
  ): Promise<number> {
    const column = sampleTextColumn(source.fieldKey);
    if (!column) return 0;
    const rows = await tx
      .select({ value: column, total: count() })
      .from(samples)
      .where(and(eq(samples.tenantId, this.tenantId), sql`${column} is not null`))
      .groupBy(column);
    const matched = rows
      .map((row) => row.value)
      .filter(
        (value): value is string =>
          typeof value === "string" && normalizeFieldValue(value) === source.normalized,
      );
    let affected = 0;
    for (const value of matched) {
      if (value === targetLabel) continue;
      const updated =
        source.fieldKey === "sample.category"
          ? await tx
              .update(samples)
              .set({ category: targetLabel })
              .where(and(eq(samples.tenantId, this.tenantId), eq(samples.category, value)))
              .returning({ id: samples.id })
          : source.fieldKey === "sample.composition"
            ? await tx
                .update(samples)
                .set({ composition: targetLabel })
                .where(and(eq(samples.tenantId, this.tenantId), eq(samples.composition, value)))
                .returning({ id: samples.id })
            : await tx
                .update(samples)
                .set({ color: targetLabel })
                .where(and(eq(samples.tenantId, this.tenantId), eq(samples.color, value)))
                .returning({ id: samples.id });
      affected += updated.length;
    }
    return affected;
  }

  private async nextSortOrder(tx: Db | Tx, fieldKey: FieldKey): Promise<number> {
    const rows = await tx
      .select({ max: sql<number | null>`max(${fieldOptions.sortOrder})` })
      .from(fieldOptions)
      .where(and(eq(fieldOptions.tenantId, this.tenantId), eq(fieldOptions.fieldKey, fieldKey)));
    const max = rows[0]?.max;
    return (max === null || max === undefined ? 0 : Number(max)) + 10;
  }

  private async getRow(id: string): Promise<FieldOptionRow> {
    const rows = await this.db
      .select()
      .from(fieldOptions)
      .where(and(eq(fieldOptions.id, id), eq(fieldOptions.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw this.notFound(id);
    return row;
  }

  private async requireRow(tx: Db | Tx, id: string): Promise<FieldOptionRow> {
    const rows = await tx
      .select()
      .from(fieldOptions)
      .where(and(eq(fieldOptions.id, id), eq(fieldOptions.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw this.notFound(id);
    return row;
  }

  private notFound(id: string): KernelError {
    return new KernelError("RESOURCE_NOT_FOUND", `选项不存在：${id}`, {
      resourceType: "field_option",
      resourceId: id,
    });
  }

  private async audit(
    tx: Tx | Db,
    ctx: KernelContext,
    action:
      | "FIELD_OPTION_CREATED"
      | "FIELD_OPTION_UPDATED"
      | "FIELD_OPTION_DELETED"
      | "FIELD_OPTION_MERGED"
      | "FIELD_OPTION_REORDERED",
    row: FieldOptionRow,
    before: JsonValue | null,
    after: Record<string, JsonValue> | null,
  ): Promise<void> {
    await appendAudit(
      tx,
      ctx,
      {
        action,
        entityType: "field_option",
        entityId: row.id,
        entityLabel: row.label,
        before,
        after: after ? { fieldKey: row.fieldKey, ...after } : null,
      },
      this.tenantId,
    );
  }
}
