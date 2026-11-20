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
export const ResourceFieldView = ResourceField.pick({
  fieldName: true,
  value: true,
  status: true,
  sourceKind: true,
  sourceId: true,
  updatedAt: true,
});
export type ResourceFieldView = z.infer<typeof ResourceFieldView>;
