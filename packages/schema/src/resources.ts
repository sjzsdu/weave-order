import { z } from "zod";
import { EntityId, JsonValueSchema, Timestamp } from "./domain";

/**
 * 资源契约：资源状态、字段出处矩阵、原件与 OCR 结果。
 *
 * 三条不可动摇的约定：
 * 1. 资源（客户/样品/联系人）是独立聚合根，跨事项共享；
 * 2. 每个字段都保留出处（哪张原件 / 历史 / 人工），用户可逐字段确认或改正；
 * 3. 原件不可变，OCR 结果只是原件之上的可重放缓存，不是真相本身。
 */

/**
 * 资源生命周期状态（文档 §3.2）的唯一定义在 `domain.ts`，
 * 因为 `Customer` 实体也要引用它；这里重新导出，避免调用方跨文件找。
 */

/** 字段出处矩阵覆盖的资源类型。 */
export const ResourceType = z.enum(["customer", "contact", "sample"]);
export type ResourceType = z.infer<typeof ResourceType>;

/**
 * 字段级状态：
 * - `CONFIRMED` 用户看过并接受；
 * - `PENDING` 有候选值但尚未确认（草稿的主状态）；
 * - `EDITED` 用户改过（value 是改后的值，原件仍可回查）；
 * - `CONFLICT` 多个来源给出不同值，等待用户选择。
 */
export const ResourceFieldStatus = z.enum(["CONFIRMED", "PENDING", "EDITED", "CONFLICT"]);
export type ResourceFieldStatus = z.infer<typeof ResourceFieldStatus>;

/**
 * 字段出处类别。`manual` 表示人工录入（无原件），矩阵里必须显式标出，
 * 不能把「没出处的值」伪装成「识别出来的值」。
 */
export const ResourceFieldSourceKind = z.enum(["bizcard", "label", "history", "manual", "llm"]);
export type ResourceFieldSourceKind = z.infer<typeof ResourceFieldSourceKind>;

/** 原件类型：图片 / PDF 走对象存储，文本存原文。 */
export const SourceKind = z.enum(["IMAGE", "PDF", "TEXT"]);
export type SourceKind = z.infer<typeof SourceKind>;

/**
 * OCR 结果状态。`PENDING` 表示排队或重试中，不是「识别为空」；
 * 失败必须带机器可读的 `failureCode`，不写自由文本。
 */
export const OcrStatus = z.enum(["PENDING", "SUCCEEDED", "FAILED"]);
export type OcrStatus = z.infer<typeof OcrStatus>;

/** OCR 失败原因的枚举（DB 列是 varchar，契约约束取值集合）。 */
export const OcrFailureCode = z.enum([
  "LOW_CONFIDENCE",
  "UNREADABLE_IMAGE",
  "UNSUPPORTED_FORMAT",
  "PROVIDER_ERROR",
  "TIMEOUT",
]);
export type OcrFailureCode = z.infer<typeof OcrFailureCode>;

/**
 * 原件（值对象，不可变）。
 * 图片/PDF 只存 `objectKey`（`tenant/<id>/...` 前缀），文本原件存 `textContent`。
 */
export const Source = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    kind: SourceKind,
    objectKey: z.string().min(1).max(512).nullable(),
    textContent: z.string().max(100_000).nullable(),
    mimeType: z.string().max(128).nullable(),
    byteSize: z.number().int().nonnegative().nullable(),
    createdAt: Timestamp,
  })
  .strict()
  .refine(
    (source) => (source.kind === "TEXT" ? source.textContent !== null : source.objectKey !== null),
    {
      message: "TEXT 原件必须有原文，图片/PDF 原件必须有 objectKey",
    },
  );
export type Source = z.infer<typeof Source>;

/** 字段出处矩阵的一行：一个资源的某一个字段，来自哪里、确认到哪一步。 */
export const ResourceField = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    resourceType: ResourceType,
    resourceId: EntityId,
    /** 字段名用资源自身的英文键（`name` / `composition` / `weight` ...）。 */
    fieldName: z.string().min(1).max(64),
    /** 候选值 / 确认值；结构随字段类型变化，故用 JSON。 */
    value: JsonValueSchema,
    status: ResourceFieldStatus,
    /** 出处原件；`manual` 结果没有原件，为 null。 */
    sourceId: EntityId.nullable(),
    sourceKind: ResourceFieldSourceKind,
    updatedBy: z.string().max(128).nullable(),
    updatedAt: Timestamp,
  })
  .strict();
export type ResourceField = z.infer<typeof ResourceField>;

/** OCR 结果（原件之上的可重放缓存）。 */
export const OcrResult = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    sourceId: EntityId,
    /** 引擎 + 版本（如 `multimodal:gpt-4o-mini@2026-01`），便于回放与切换对比。 */
    engine: z.string().min(1).max(128),
    /** 原始识别输出（provider 原样返回），排查失败模式用。 */
    raw: JsonValueSchema.nullable(),
    /** 抽取出的结构化字段（字段名 → 值），供写入 `resource_fields`。 */
    fields: JsonValueSchema.nullable(),
    status: OcrStatus,
    failureCode: OcrFailureCode.nullable(),
    attempts: z.number().int().nonnegative(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type OcrResult = z.infer<typeof OcrResult>;

/** 资源读模型里的「字段 + 出处」视图（`GET /customers/:id/fields` 的行）。 */
export const ResourceFieldCandidate = z
  .object({
    value: JsonValueSchema,
    sourceKind: ResourceFieldSourceKind,
    sourceId: EntityId.nullable(),
  })
  .strict();
export type ResourceFieldCandidate = z.infer<typeof ResourceFieldCandidate>;

/**
 * CONFLICT 行的存储形状：两个以上来源给出不同值。
 *
 * 冲突值不能只保留「最后写入的那个」——用户就失去了做选择的依据。
 * 因此 CONFLICT 行的 `value` 存 `{ candidates: [...] }`，GET 时展开为
 * `candidates`，PATCH 选中某个候选后回到普通标量值。
 */
export const ResourceFieldConflictValue = z
  .object({
    candidates: z.array(ResourceFieldCandidate).min(2),
  })
  .strict();
export type ResourceFieldConflictValue = z.infer<typeof ResourceFieldConflictValue>;

export const ResourceFieldView = ResourceField.pick({
  fieldName: true,
  value: true,
  status: true,
  sourceKind: true,
  sourceId: true,
  updatedAt: true,
}).extend({
  /** CONFLICT 行的候选值与各自出处；非冲突行为空数组。 */
  candidates: z.array(ResourceFieldCandidate).default([]),
});
export type ResourceFieldView = z.infer<typeof ResourceFieldView>;

/** 草稿创建时提交的一个字段（OCR / 理解卡 / 人工补录共用）。 */
export const DraftFieldInput = z
  .object({
    fieldName: z.string().min(1).max(64),
    value: JsonValueSchema,
    sourceKind: ResourceFieldSourceKind.default("manual"),
    /** 出处原件；无原件（人工录入 / 模型直抽）为 null。 */
    sourceId: EntityId.nullable().optional(),
  })
  .strict();
export type DraftFieldInput = z.infer<typeof DraftFieldInput>;

/** `PATCH /customers/:id/fields` 的单行：逐字段确认或改正。 */
export const UpdateResourceFieldInput = z
  .object({
    fieldName: z.string().min(1).max(64),
    value: JsonValueSchema,
  })
  .strict();
export type UpdateResourceFieldInput = z.infer<typeof UpdateResourceFieldInput>;

export const UpdateResourceFieldsInput = z
  .object({
    fields: z.array(UpdateResourceFieldInput).min(1).max(50),
  })
  .strict();
export type UpdateResourceFieldsInput = z.infer<typeof UpdateResourceFieldsInput>;

export const ResourceFieldsResponse = z
  .object({
    resourceType: ResourceType,
    resourceId: EntityId,
    /** 资源状态：草稿页据此决定「确认可用」按钮是否可用。 */
    resourceStatus: z.enum(["DRAFT", "AVAILABLE", "ARCHIVED"]),
    fields: z.array(ResourceFieldView),
    /** 仍为 PENDING / CONFLICT 的字段数（确认页的「还有 N 项待确认」）。 */
    pendingCount: z.number().int().nonnegative(),
  })
  .strict();
export type ResourceFieldsResponse = z.infer<typeof ResourceFieldsResponse>;

const ResourceCount = z.number().int().nonnegative();

/** 资源首页的聚合读模型；只返回计数，不携带资源或审计明细。 */
export const ResourceOverview = z
  .object({
    generatedAt: Timestamp,
    customers: z
      .object({
        total: ResourceCount,
        tiers: z.array(
          z
            .object({
              code: z.string().min(1).max(64),
              count: ResourceCount,
            })
            .strict(),
        ),
      })
      .strict(),
    samples: z
      .object({
        available: ResourceCount,
        draft: ResourceCount,
        archived: ResourceCount,
        categories: z.array(
          z
            .object({
              /** null 统一表示 NULL 或纯空白的未分类样品。 */
              code: z.string().min(1).max(64).nullable(),
              count: ResourceCount,
            })
            .strict(),
        ),
        completeness: z.array(
          z
            .object({
              key: z.enum(["composition", "weight", "width", "primaryImage"]),
              completeCount: ResourceCount,
              missingCount: ResourceCount,
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();
export type ResourceOverview = z.infer<typeof ResourceOverview>;
