import { z } from "zod";
import { ZodIssueSummary } from "./common";
import { EntityId, FollowupPreference, PaymentPattern, PricingBehavior } from "./domain";
import { CreateCustomerInput, CreateSampleInput } from "./kernel";

/**
 * 第六步：数据导入（Excel/CSV）的契约 —— 唯一来源。
 *
 * 铁律：导入的每一行都用这里复用内核 `CreateCustomerInput` / `CreateSampleInput`
 * 的 Zod 契约严格 `.strict()` 校验；失败语义以 `code` 可判别联合表达，
 * 不存在「静默落库」或「看不出哪行坏了」的模糊状态。
 *
 * 口径（见内核 ImportService）：**整批原子、全量校验、单事务回滚**。
 * `committed=true` 表示整批全部落库；否则一行都不落。无论哪种，每一行都有
 * 可判别回执（成功 / 具体失败码），便于修正后重导。
 */

/** 单批每个实体类型的最大行数（防御超大文件打爆事务）。 */
export const MAX_IMPORT_ROWS = 200;

/** 可导入的实体种类。 */
export const ImportEntityKind = z.enum(["customer", "fabric_sample"]);
export type ImportEntityKind = z.infer<typeof ImportEntityKind>;

/**
 * 客户私有上下文的可导入部分。
 * `customerId` / `decisionDeltas` / `updatedAt` 由内核管理，不接受导入；
 * 其余三个行为对象复用领域契约（唯一来源）。缺省字段由内核补默认值。
 */
export const CustomerContextImport = z
  .object({
    preferenceNotes: z.array(z.string().max(500)).optional(),
    pricingBehavior: PricingBehavior.optional(),
    paymentPattern: PaymentPattern.optional(),
    followupPreference: FollowupPreference.optional(),
  })
  .strict();
export type CustomerContextImport = z.infer<typeof CustomerContextImport>;

/** 单行客户导入契约：在内核 Create 输入上追加可选的私有上下文。 */
export const CustomerImportRow = CreateCustomerInput.extend({
  context: CustomerContextImport.optional(),
}).strict();
export type CustomerImportRow = z.infer<typeof CustomerImportRow>;

/** 单行样品导入契约：直接复用内核 Create 输入（金额整数分、单位、状态都在此校验）。 */
export const SampleImportRow = CreateSampleInput;
export type SampleImportRow = z.infer<typeof SampleImportRow>;

/**
 * 导入批次信封。行内容用 `unknown` 承载（不是 `any`），由内核逐行用上面的
 * `CustomerImportRow` / `SampleImportRow` 做严格校验并给逐行回执 ——
 * 信封本身只约束结构与规模。
 */
export const ImportBatch = z
  .object({
    customers: z.array(z.unknown()).max(MAX_IMPORT_ROWS).default([]),
    samples: z.array(z.unknown()).max(MAX_IMPORT_ROWS).default([]),
  })
  .strict();
export type ImportBatch = z.infer<typeof ImportBatch>;

/** 单行失败的可判别码。 */
const InvalidRowError = z
  .object({
    code: z.literal("INVALID_INPUT"),
    message: z.string(),
    /** Zod 逐字段 issues（剔除 zod 内部细节）。 */
    issues: z.array(ZodIssueSummary),
  })
  .strict();

const DuplicateInBatchError = z
  .object({
    code: z.literal("DUPLICATE_IN_BATCH"),
    message: z.string(),
    /** 与本行冲突的、批次内更早的行号（0-based）。 */
    conflictsWithRow: z.number().int().nonnegative(),
  })
  .strict();

const DuplicateInDbError = z
  .object({
    code: z.literal("DUPLICATE_IN_DB"),
    message: z.string(),
    /** 库中已存在同 code 的实体 ID。 */
    existingId: EntityId,
  })
  .strict();

const WriteFailedError = z
  .object({
    code: z.literal("WRITE_FAILED"),
    message: z.string(),
  })
  .strict();

export const ImportRowError = z.discriminatedUnion("code", [
  InvalidRowError,
  DuplicateInBatchError,
  DuplicateInDbError,
  WriteFailedError,
]);
export type ImportRowError = z.infer<typeof ImportRowError>;
export type ImportRowErrorCode = ImportRowError["code"];

/** 单行回执（成功 / 失败可判别）。row 为该实体数组内的 0-based 下标，key 为业务 code。 */
const ImportOkReceipt = z
  .object({
    ok: z.literal(true),
    kind: ImportEntityKind,
    row: z.number().int().nonnegative(),
    key: z.string(),
  })
  .strict();
const ImportFailReceipt = z
  .object({
    ok: z.literal(false),
    kind: ImportEntityKind,
    row: z.number().int().nonnegative(),
    key: z.string(),
    error: ImportRowError,
  })
  .strict();
export const ImportRowReceipt = z.discriminatedUnion("ok", [ImportOkReceipt, ImportFailReceipt]);
export type ImportRowReceipt = z.infer<typeof ImportRowReceipt>;

/** 批次级失败原因（整批原子口径下的顶层错误）。 */
export const ImportBatchError = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("PERMISSION_DENIED"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("INVALID_BATCH"),
      message: z.string(),
      issues: z.array(ZodIssueSummary),
    })
    .strict(),
  z
    .object({
      code: z.literal("BATCH_REJECTED"),
      message: z.string(),
      rejectedRows: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      code: z.literal("WRITE_FAILED"),
      message: z.string(),
    })
    .strict(),
]);
export type ImportBatchError = z.infer<typeof ImportBatchError>;

/**
 * 导入结果（服务端权威回执）。
 * `committed=false` 时 `importedCustomers`/`importedSamples` 必为 0 —— 单事务
 * 回滚保证不会半途留脏数据。`correlationId` 把本批次所有 HUMAN 审计串起来。
 */
export const ImportBatchResult = z
  .object({
    committed: z.boolean(),
    batchError: ImportBatchError.nullable(),
    totalRows: z.number().int().nonnegative(),
    okRows: z.number().int().nonnegative(),
    rejectedRows: z.number().int().nonnegative(),
    importedCustomers: z.number().int().nonnegative(),
    importedSamples: z.number().int().nonnegative(),
    correlationId: EntityId.nullable(),
    rows: z.array(ImportRowReceipt),
  })
  .strict();
export type ImportBatchResult = z.infer<typeof ImportBatchResult>;
