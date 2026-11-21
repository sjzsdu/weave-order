import { customers, resourceFields, samples } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  ResourceFieldConflictValue,
  UpdateResourceFieldsInput,
  parseWeightGsm,
} from "@weave-order/schema";
import type {
  DraftFieldInput,
  JsonValue,
  ResourceFieldSourceKind,
  ResourceFieldView,
  ResourceStatus,
  ResourceType,
} from "@weave-order/schema";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";
import { toIso } from "./mappers";

type ResourceFieldRow = typeof resourceFields.$inferSelect;

/** 客户矩阵覆盖的字段：主表的可确认信息 + 编号（只读参考）。 */
const CUSTOMER_FIELDS = [
  "code",
  "name",
  "tier",
  "contactName",
  "contactPhone",
  "contactEmail",
  // 名片上常见但主表没有列：只存在字段矩阵里，仍可逐字段确认/改正。
  "title",
  "address",
  "business",
] as const;
const SAMPLE_FIELDS = [
  "code",
  "name",
  "composition",
  "category",
  "color",
  "weight",
  "unit",
  // 标签上的规格：存矩阵，不写主表（报价只读 weight/unit，其余供溯源）。
  "width",
  "lot",
  "supplier",
] as const;

const FIELDS_BY_TYPE: Record<ResourceType, readonly string[]> = {
  customer: CUSTOMER_FIELDS,
  contact: CUSTOMER_FIELDS,
  sample: SAMPLE_FIELDS,
};

const WRITABLE_CUSTOMER_FIELDS = new Set([
  "name",
  "tier",
  "contactName",
  "contactPhone",
  "contactEmail",
]);
const WRITABLE_SAMPLE_FIELDS = new Set([
  "name",
  "composition",
  "category",
  "color",
  "weight",
  "unit",
]);

function jsonKey(value: JsonValue): string {
  return JSON.stringify(value ?? null);
}

/** 字段值落到字符串列时的统一转换：对象/数组不产生 `[object Object]`。 */
function asText(value: JsonValue | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** CONFLICT 行存的是 `{ candidates }`；普通行是标量。 */
function splitValue(value: JsonValue | null): {
  value: JsonValue | null;
  candidates: ResourceFieldView["candidates"];
} {
  const conflict = ResourceFieldConflictValue.safeParse(value);
  if (conflict.success) return { value: null, candidates: conflict.data.candidates };
  return { value: value ?? null, candidates: [] };
}

function mapView(row: ResourceFieldRow): ResourceFieldView {
  const split = splitValue(row.value ?? null);
  return {
    fieldName: row.fieldName,
    value: split.value,
    status: row.status,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    updatedAt: toIso(row.updatedAt),
    candidates: split.candidates,
  };
}

/**
 * 字段出处矩阵（`resource_fields`）的唯一读写入口。
 *
 * 设计取舍：
 * - 矩阵只存「有出处 / 待确认」的字段；主表里从未经 OCR 的值在读取时
 *   合成为 `manual / CONFIRMED` 行，不为了展示回填一堆重复行。
 * - 冲突不是「最后写入者胜」，而是把候选值都留下，等用户选。
 */
export class ResourceFieldService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  /**
   * 草稿创建时写入字段矩阵（在调用方事务内执行）。
   * 同一字段多个来源给出不同值时落 CONFLICT，而不是覆盖。
   */
  async writeDraftFields(
    tx: Tx,
    resourceType: ResourceType,
    resourceId: string,
    fields: DraftFieldInput[],
  ): Promise<void> {
    if (fields.length === 0) return;
    const grouped = new Map<string, DraftFieldInput[]>();
    for (const field of fields) {
      const bucket = grouped.get(field.fieldName) ?? [];
      bucket.push(field);
      grouped.set(field.fieldName, bucket);
    }

    for (const [fieldName, candidates] of grouped) {
      const distinct = new Map<string, DraftFieldInput>();
      for (const candidate of candidates) {
        distinct.set(jsonKey(candidate.value), candidate);
      }
      const entries = [...distinct.values()];
      const first = entries[0];
      if (!first) continue;

      if (entries.length > 1) {
        const conflict: JsonValue = {
          candidates: entries.map((entry) => ({
            value: entry.value,
            sourceKind: entry.sourceKind,
            sourceId: entry.sourceId ?? null,
          })),
        };
        await tx
          .insert(resourceFields)
          .values({
            tenantId: this.tenantId,
            resourceType,
            resourceId,
            fieldName,
            value: conflict,
            status: "CONFLICT",
            sourceId: first.sourceId ?? null,
            sourceKind: first.sourceKind,
          })
          .onConflictDoUpdate({
            target: [
              resourceFields.tenantId,
              resourceFields.resourceType,
              resourceFields.resourceId,
              resourceFields.fieldName,
            ],
            set: {
              value: conflict,
              status: "CONFLICT",
              sourceId: first.sourceId ?? null,
              sourceKind: first.sourceKind,
              updatedAt: new Date(),
            },
          });
        continue;
      }

      await tx
        .insert(resourceFields)
        .values({
          tenantId: this.tenantId,
          resourceType,
          resourceId,
          fieldName,
          value: first.value,
          status: "PENDING",
          sourceId: first.sourceId ?? null,
          sourceKind: first.sourceKind,
        })
        .onConflictDoUpdate({
          target: [
            resourceFields.tenantId,
            resourceFields.resourceType,
            resourceFields.resourceId,
            resourceFields.fieldName,
          ],
          set: {
            value: first.value,
            status: "PENDING",
            sourceId: first.sourceId ?? null,
            sourceKind: first.sourceKind,
            updatedAt: new Date(),
          },
        });
    }
  }

  /** 草稿必填项缺失时补一行 PENDING，让确认页能明确显示「待补充」。 */
  async markPending(
    tx: Tx,
    resourceType: ResourceType,
    resourceId: string,
    fieldName: string,
  ): Promise<void> {
    await tx
      .insert(resourceFields)
      .values({
        tenantId: this.tenantId,
        resourceType,
        resourceId,
        fieldName,
        value: null,
        status: "PENDING",
        sourceKind: "manual",
      })
      .onConflictDoNothing({
        target: [
          resourceFields.tenantId,
          resourceFields.resourceType,
          resourceFields.resourceId,
          resourceFields.fieldName,
        ],
      });
  }

  /**
   * 读矩阵：矩阵行 + 主表里没有出处的值（合成 manual / CONFIRMED）。
   * 草稿里 `name` 是占位值，矩阵行 PENDING 会覆盖它，用户看到的是「待补充」。
   */
  async list(
    resourceType: ResourceType,
    resourceId: string,
    resourceStatus: ResourceStatus,
  ): Promise<ResourceFieldView[]> {
    const rows = await this.db
      .select()
      .from(resourceFields)
      .where(
        and(
          eq(resourceFields.tenantId, this.tenantId),
          eq(resourceFields.resourceType, resourceType),
          eq(resourceFields.resourceId, resourceId),
        ),
      );
    const byName = new Map(rows.map((row) => [row.fieldName, row]));
    const views: ResourceFieldView[] = [];

    if (resourceType === "customer" || resourceType === "contact") {
      const [customer] = await this.db
        .select()
        .from(customers)
        .where(and(eq(customers.id, resourceId), eq(customers.tenantId, this.tenantId)))
        .limit(1);
      if (!customer) {
        throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${resourceId}`, {
          customerId: resourceId,
        });
      }
      const mainValues: Record<string, JsonValue | null> = {
        code: customer.code,
        name: customer.name,
        tier: customer.tier,
        contactName: customer.contactName,
        contactPhone: customer.contactPhone,
        contactEmail: customer.contactEmail,
      };
      for (const fieldName of CUSTOMER_FIELDS) {
        const row = byName.get(fieldName);
        if (row) {
          views.push(mapView(row));
          continue;
        }
        const value = mainValues[fieldName] ?? null;
        if (value === null) continue;
        views.push({
          fieldName,
          value,
          // 没有任何原件出处的人工值：显式标 manual，不伪装成识别结果。
          status: "CONFIRMED",
          sourceKind: "manual",
          sourceId: null,
          updatedAt: toIso(customer.createdAt),
          candidates: [],
        });
      }
      return views;
    }

    const [sample] = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.id, resourceId), eq(samples.tenantId, this.tenantId)))
      .limit(1);
    if (!sample) {
      throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${resourceId}`, {
        resourceType: "sample",
        resourceId,
      });
    }
    const mainValues: Record<string, JsonValue | null> = {
      code: sample.code,
      name: sample.name,
      composition: sample.composition,
      category: sample.category,
      color: sample.color,
      weight: sample.weight,
      unit: sample.unit,
    };
    for (const fieldName of SAMPLE_FIELDS) {
      const row = byName.get(fieldName);
      if (row) {
        views.push(mapView(row));
        continue;
      }
      const value = mainValues[fieldName] ?? null;
      if (value === null) continue;
      views.push({
        fieldName,
        value,
        status: "CONFIRMED",
        sourceKind: "manual",
        sourceId: null,
        updatedAt: toIso(sample.createdAt),
        candidates: [],
      });
    }
    void resourceStatus;
    return views;
  }

  /**
   * 逐字段确认 / 改正。
   *
   * 状态规则：
   * - 值没变 → CONFIRMED（「我看过了」）；
   * - 值变了 → EDITED（保留原出处，用户改后的值可追溯）；
   * - 原行是 CONFLICT：选中某个候选 → CONFIRMED 且带该候选的出处；
   *   选了一个新值 → EDITED + manual。
   */
  async updateFields(
    resourceType: ResourceType,
    resourceId: string,
    input: unknown,
    ctx: KernelContext,
  ): Promise<ResourceFieldView[]> {
    const parsed = UpdateResourceFieldsInput.parse(input);
    const allowed = new Set(FIELDS_BY_TYPE[resourceType]);
    for (const field of parsed.fields) {
      if (!allowed.has(field.fieldName)) {
        throw new KernelError("KERNEL_REJECTED", `未知字段：${field.fieldName}`, {
          reason: "UNKNOWN_RESOURCE_FIELD",
        });
      }
    }

    await this.db.transaction(async (tx) => {
      for (const field of parsed.fields) {
        const existingRows = await tx
          .select()
          .from(resourceFields)
          .where(
            and(
              eq(resourceFields.tenantId, this.tenantId),
              eq(resourceFields.resourceType, resourceType),
              eq(resourceFields.resourceId, resourceId),
              eq(resourceFields.fieldName, field.fieldName),
            ),
          )
          .limit(1);
        const existing = existingRows[0];
        const conflict = existing ? splitValue(existing.value ?? null) : null;
        const chosen = conflict?.candidates.find(
          (candidate) => jsonKey(candidate.value) === jsonKey(field.value),
        );
        const unchanged = existing
          ? conflict && conflict.candidates.length > 0
            ? false
            : jsonKey(existing.value ?? null) === jsonKey(field.value)
          : false;
        const status = chosen ? "CONFIRMED" : unchanged ? "CONFIRMED" : "EDITED";
        const sourceKind: ResourceFieldSourceKind = chosen
          ? chosen.sourceKind
          : (existing?.sourceKind ?? "manual");
        const sourceId = chosen ? chosen.sourceId : (existing?.sourceId ?? null);

        await tx
          .insert(resourceFields)
          .values({
            tenantId: this.tenantId,
            resourceType,
            resourceId,
            fieldName: field.fieldName,
            value: field.value,
            status,
            sourceKind,
            sourceId,
            updatedBy: ctx.actor.id,
          })
          .onConflictDoUpdate({
            target: [
              resourceFields.tenantId,
              resourceFields.resourceType,
              resourceFields.resourceId,
              resourceFields.fieldName,
            ],
            set: {
              value: field.value,
              status,
              sourceKind,
              sourceId,
              updatedBy: ctx.actor.id,
              updatedAt: new Date(),
            },
          });
      }

      await this.syncMainTable(tx, resourceType, resourceId, parsed.fields);
      await appendAudit(
        tx,
        ctx,
        {
          action: resourceType === "sample" ? "SAMPLE_FIELDS_UPDATED" : "CUSTOMER_FIELDS_UPDATED",
          entityType: resourceType,
          entityId: resourceId,
          before: null,
          after: { fields: parsed.fields.map((field) => field.fieldName) },
        },
        this.tenantId,
      );
    });

    return this.list(resourceType, resourceId, "AVAILABLE");
  }

  /** 确认后的字段值必须落到主表，否则列表/报价读到的还是旧值。 */
  private async syncMainTable(
    tx: Tx,
    resourceType: ResourceType,
    resourceId: string,
    fields: Array<{ fieldName: string; value: JsonValue }>,
  ): Promise<void> {
    if (resourceType === "customer" || resourceType === "contact") {
      const values: Partial<typeof customers.$inferInsert> = { updatedAt: new Date() };
      for (const field of fields) {
        if (!WRITABLE_CUSTOMER_FIELDS.has(field.fieldName)) continue;
        const text = asText(field.value);
        if (field.fieldName === "name") {
          if (!text || text.trim() === "") {
            throw new KernelError("KERNEL_REJECTED", "客户名称不能为空", {
              reason: "CUSTOMER_NAME_REQUIRED",
            });
          }
          values.name = text;
        }
        if (field.fieldName === "tier" && text) values.tier = text;
        if (field.fieldName === "contactName") values.contactName = text;
        if (field.fieldName === "contactPhone") values.contactPhone = text;
        if (field.fieldName === "contactEmail") values.contactEmail = text;
      }
      await tx
        .update(customers)
        .set(values)
        .where(and(eq(customers.id, resourceId), eq(customers.tenantId, this.tenantId)));
      return;
    }

    const values: Partial<typeof samples.$inferInsert> = { updatedAt: new Date() };
    for (const field of fields) {
      if (!WRITABLE_SAMPLE_FIELDS.has(field.fieldName)) continue;
      const text = asText(field.value);
      if (field.fieldName === "name") {
        if (!text || text.trim() === "") {
          throw new KernelError("KERNEL_REJECTED", "样品名称不能为空", {
            reason: "SAMPLE_NAME_REQUIRED",
          });
        }
        values.name = text;
      }
      if (field.fieldName === "composition") values.composition = text;
      if (field.fieldName === "category") values.category = text;
      if (field.fieldName === "color") values.color = text;
      if (field.fieldName === "weight") {
        values.weight = text;
        // 逐字段确认也是写入侧：克重仍由同一解析器派生。
        values.weightGsm = parseWeightGsm(text);
      }
      if (
        field.fieldName === "unit" &&
        (text === "meter" || text === "kilogram" || text === "yard" || text === "piece")
      ) {
        values.unit = text;
      }
    }
    await tx
      .update(samples)
      .set(values)
      .where(and(eq(samples.id, resourceId), eq(samples.tenantId, this.tenantId)));
  }

  /** 草稿确认前的阻塞检查：必填字段必须已有用户确认的值。 */
  async assertRequiredConfirmed(
    resourceType: ResourceType,
    resourceId: string,
    required: readonly string[],
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(resourceFields)
      .where(
        and(
          eq(resourceFields.tenantId, this.tenantId),
          eq(resourceFields.resourceType, resourceType),
          eq(resourceFields.resourceId, resourceId),
          inArray(resourceFields.fieldName, [...required]),
        ),
      );
    const ok = new Set(
      rows
        .filter(
          (row) => (row.status === "CONFIRMED" || row.status === "EDITED") && row.value !== null,
        )
        .map((row) => row.fieldName),
    );
    const missing = required.filter((field) => !ok.has(field));
    if (missing.length > 0) {
      throw new KernelError("KERNEL_REJECTED", `还有字段待确认：${missing.join(", ")}`, {
        reason: "RESOURCE_FIELDS_PENDING",
      });
    }
  }
}
