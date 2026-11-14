import { randomUUID } from "node:crypto";
import {
  customerContexts,
  customers,
  quoteItems,
  quotes,
  sampleTextEmbeddings,
  sampleShipmentItems,
  sampleShipments,
  samples,
} from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import {
  CustomerImportRow,
  ImportBatch,
  ImportBatchResult,
  SampleImportRow,
} from "@weave-order/schema";
import type {
  CreateCustomerInput,
  CreateSampleInput,
  CustomerContextImport,
  ImportBatchError,
  ImportBatchResult as ImportResult,
  ImportRowReceipt,
  ZodIssueSummary,
} from "@weave-order/schema";
import { ZodError } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import type { CustomerService } from "./customers.service";
import { errorChainMessage } from "./errors";
import type { SampleIndexService } from "./sample-index.service";
import type { SampleService } from "./samples.service";

interface ValidatedCustomer {
  kind: "customer";
  row: number;
  key: string;
  customer: CreateCustomerInput;
  context?: CustomerContextImport;
}

interface ValidatedSample {
  kind: "fabric_sample";
  row: number;
  key: string;
  sample: CreateSampleInput;
}

type ValidatedRow = ValidatedCustomer | ValidatedSample;

/** 导入选项：默认口径不变，只有显式开关才允许替换库中同 code 的旧行。 */
export interface ImportOptions {
  /**
   * 重置已存在的同 code 行：在同一事务内先删除旧客户 / 样品（含客户上下文与
   * 样品向量），以及引用它们的报价、寄样单与明细，再写入新行。默认关闭；
   * 关闭时库中已有 code 仍按 `DUPLICATE_IN_DB` 整批拒绝。任何删除或写入失败
   * 都会整批回滚，旧数据不会丢一半。
   */
  resetExisting?: boolean;
}

function issuesOf(error: ZodError): ZodIssueSummary[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
    code: issue.code,
    message: issue.message,
  }));
}

/** 从 unknown 行里取业务 code 做回执标识；取不到就退回行号，不用 any。 */
function rowKey(raw: unknown, row: number): string {
  if (typeof raw === "object" && raw !== null && "code" in raw) {
    const code: unknown = raw.code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return `#${row}`;
}

function buildResult(args: {
  committed: boolean;
  batchError: ImportBatchError | null;
  totalRows: number;
  rows: ImportRowReceipt[];
  importedCustomers: number;
  importedSamples: number;
  correlationId: string | null;
}): ImportResult {
  const okRows = args.rows.filter((receipt) => receipt.ok).length;
  return ImportBatchResult.parse({
    committed: args.committed,
    batchError: args.batchError,
    totalRows: args.totalRows,
    okRows,
    rejectedRows: args.rows.length - okRows,
    importedCustomers: args.importedCustomers,
    importedSamples: args.importedSamples,
    correlationId: args.correlationId,
    rows: args.rows,
  });
}

/**
 * 数据导入内核服务 —— 业务表（customers / customer_contexts / samples /
 * sample_text_embeddings / audit_log）的唯一批量写入者。
 *
 * 口径：**整批原子、全量校验、单事务回滚（all-or-nothing）**。
 * 1. 信封 + 每行用 `packages/schema` 的 Zod 契约严格 `.strict()` 校验（纯，零写入）；
 * 2. 批内 code 重复、库中已有 code 做可判别回执（只读预检）；
 * 3. 任一行被拒 => 整批不提交，一行不落，绝不半途留脏数据；
 * 4. 全部通过 => 一个 `db.transaction` 写入所有行 + 同事务 HUMAN 审计（共用一个
 *    correlationId）；任何写入失败，整个事务回滚，仍是一行不落。
 * 无论提交与否，每一行都有可判别回执（成功 / 具体失败码），便于修正后重导。
 */
export class ImportService {
  constructor(
    private readonly db: Db,
    private readonly customerService: CustomerService,
    private readonly sampleService: SampleService,
    private readonly sampleIndex: SampleIndexService,
    private readonly tenantId: string,
  ) {}

  async execute(
    input: unknown,
    ctx: KernelContext,
    options: ImportOptions = {},
  ): Promise<ImportResult> {
    // 导入写账本必须人类发起（与 confirm / reject 同一守卫）。
    if (ctx.actor.type !== "HUMAN") {
      return buildResult({
        committed: false,
        batchError: {
          code: "PERMISSION_DENIED",
          message: "数据导入必须由人类发起（HUMAN 上下文）",
        },
        totalRows: 0,
        rows: [],
        importedCustomers: 0,
        importedSamples: 0,
        correlationId: null,
      });
    }

    // ① 信封校验（结构 / 规模 / strict）
    const envelope = ImportBatch.safeParse(input);
    if (!envelope.success) {
      return buildResult({
        committed: false,
        batchError: {
          code: "INVALID_BATCH",
          message: "导入批次结构不合法",
          issues: issuesOf(envelope.error),
        },
        totalRows: 0,
        rows: [],
        importedCustomers: 0,
        importedSamples: 0,
        correlationId: null,
      });
    }

    const rawCustomers = envelope.data.customers;
    const rawSamples = envelope.data.samples;
    const totalRows = rawCustomers.length + rawSamples.length;
    if (totalRows === 0) {
      return buildResult({
        committed: false,
        batchError: { code: "INVALID_BATCH", message: "导入批次为空（至少一行）", issues: [] },
        totalRows: 0,
        rows: [],
        importedCustomers: 0,
        importedSamples: 0,
        correlationId: null,
      });
    }
    const receipts: ImportRowReceipt[] = [];
    const validated: ValidatedRow[] = [];

    // ② 逐行 Zod 严格校验（纯）
    for (const [row, raw] of rawCustomers.entries()) {
      const key = rowKey(raw, row);
      const parsed = CustomerImportRow.safeParse(raw);
      if (!parsed.success) {
        receipts.push({
          ok: false,
          kind: "customer",
          row,
          key,
          error: {
            code: "INVALID_INPUT",
            message: "客户行未通过契约校验",
            issues: issuesOf(parsed.error),
          },
        });
        continue;
      }
      const { context, ...customer } = parsed.data;
      validated.push({ kind: "customer", row, key, customer, context });
    }
    for (const [row, raw] of rawSamples.entries()) {
      const key = rowKey(raw, row);
      const parsed = SampleImportRow.safeParse(raw);
      if (!parsed.success) {
        receipts.push({
          ok: false,
          kind: "fabric_sample",
          row,
          key,
          error: {
            code: "INVALID_INPUT",
            message: "样品行未通过契约校验",
            issues: issuesOf(parsed.error),
          },
        });
        continue;
      }
      validated.push({ kind: "fabric_sample", row, key, sample: parsed.data });
    }

    // ③ 批内 code 重复（按 kind 分命名空间；首个保留，后续判 DUPLICATE_IN_BATCH）
    const seen = new Map<string, number>();
    const deduped: ValidatedRow[] = [];
    for (const entry of validated) {
      const code = entry.kind === "customer" ? entry.customer.code : entry.sample.code;
      const mapKey = `${entry.kind}:${code}`;
      const first = seen.get(mapKey);
      if (first !== undefined) {
        receipts.push({
          ok: false,
          kind: entry.kind,
          row: entry.row,
          key: entry.key,
          error: {
            code: "DUPLICATE_IN_BATCH",
            message: `批次内 code 重复：${code}`,
            conflictsWithRow: first,
          },
        });
        continue;
      }
      seen.set(mapKey, entry.row);
      deduped.push(entry);
    }

    // ④ 库中已有 code（只读预检，可判别回执；唯一约束仍是并发兜底）
    const existingCustomers = new Map<string, string>();
    const existingSamples = new Map<string, string>();
    const customerCodes = deduped
      .filter((entry): entry is ValidatedCustomer => entry.kind === "customer")
      .map((entry) => entry.customer.code);
    const sampleCodes = deduped
      .filter((entry): entry is ValidatedSample => entry.kind === "fabric_sample")
      .map((entry) => entry.sample.code);
    if (customerCodes.length > 0) {
      const rows = await this.db
        .select({ id: customers.id, code: customers.code })
        .from(customers)
        .where(and(inArray(customers.code, customerCodes), eq(customers.tenantId, this.tenantId)));
      for (const row of rows) existingCustomers.set(row.code, row.id);
    }
    if (sampleCodes.length > 0) {
      const rows = await this.db
        .select({ id: samples.id, code: samples.code })
        .from(samples)
        .where(and(inArray(samples.code, sampleCodes), eq(samples.tenantId, this.tenantId)));
      for (const row of rows) existingSamples.set(row.code, row.id);
    }
    const checked: ValidatedRow[] = [];
    const resetExisting = options.resetExisting === true;
    for (const entry of deduped) {
      const code = entry.kind === "customer" ? entry.customer.code : entry.sample.code;
      const map = entry.kind === "customer" ? existingCustomers : existingSamples;
      const existingId = map.get(code);
      if (existingId !== undefined) {
        if (!resetExisting) {
          receipts.push({
            ok: false,
            kind: entry.kind,
            row: entry.row,
            key: entry.key,
            error: {
              code: "DUPLICATE_IN_DB",
              message: `库中已存在同 code：${code}`,
              existingId,
            },
          });
          continue;
        }
        // 重置模式：旧行在写入事务内先删后插，这里不再判为重复。
      }
      checked.push(entry);
    }

    // ⑤ 任一行被拒 => 整批不提交（零写入）。通过校验的行也给出 ok 回执。
    if (receipts.some((receipt) => !receipt.ok)) {
      for (const entry of checked) {
        receipts.push({ ok: true, kind: entry.kind, row: entry.row, key: entry.key });
      }
      return buildResult({
        committed: false,
        batchError: {
          code: "BATCH_REJECTED",
          message: "存在坏行或重复行，整批未提交（一行不落）",
          rejectedRows: receipts.filter((receipt) => !receipt.ok).length,
        },
        totalRows,
        rows: receipts,
        importedCustomers: 0,
        importedSamples: 0,
        correlationId: null,
      });
    }

    // ⑥ 单事务原子写入（向量不在这里算：提交后统一 reindex，模型慢/抖动不拖垮导入）
    const correlationId = randomUUID();
    const fullCtx: KernelContext = { ...ctx, correlationId };
    // 事务提交后才会被赋值；失败分支保持空数组（下面走不到 reindex 也会是安全的）。
    let importedSampleIdsForReindex: string[] = [];
    try {
      const importedSampleIds: string[] = [];
      await this.db.transaction(async (tx) => {
        if (resetExisting) {
          await this.resetWithin(tx, existingCustomers, existingSamples, fullCtx);
        }
        for (const entry of checked) {
          if (entry.kind === "customer") {
            await this.customerService.insertWithin(tx, entry.customer, fullCtx, entry.context);
          } else {
            const sample = await this.sampleService.insertWithin(tx, entry.sample, fullCtx);
            importedSampleIds.push(sample.id);
          }
        }
      });
      // 与事务同一作用域：只有提交成功才拿得到这批 id。
      importedSampleIdsForReindex = importedSampleIds;
    } catch (error) {
      const message = errorChainMessage(error);
      const failed: ImportRowReceipt[] = checked.map((entry) => ({
        ok: false,
        kind: entry.kind,
        row: entry.row,
        key: entry.key,
        error: {
          code: "WRITE_FAILED",
          message: `整批已回滚：${message}`.slice(0, 500),
        },
      }));
      return buildResult({
        committed: false,
        batchError: {
          code: "WRITE_FAILED",
          message: `写入失败，整批事务回滚：${message}`.slice(0, 500),
        },
        totalRows,
        rows: failed,
        importedCustomers: 0,
        importedSamples: 0,
        correlationId: null,
      });
    }

    // ⑦ 提交后补索引：只补本次导入的新样行，不全租户重算；失败不回滚导入，但留审计。
    try {
      const reindex = await this.sampleIndex.reindexSamples(importedSampleIdsForReindex);
      if (reindex.failures.length > 0) {
        await appendAudit(
          this.db,
          fullCtx,
          {
            action: "SAMPLE_INDEX_FAILED",
            entityType: "tenant",
            entityId: this.tenantId,
            after: {
              source: "import",
              failed: reindex.failures.length,
              indexed: reindex.indexed,
              samples: reindex.failures.slice(0, 20).map((failure) => ({
                sampleId: failure.sampleId,
                code: failure.code,
                message: failure.message,
              })),
            },
          },
          this.tenantId,
        );
      }
    } catch (error) {
      await appendAudit(
        this.db,
        fullCtx,
        {
          action: "SAMPLE_INDEX_FAILED",
          entityType: "tenant",
          entityId: this.tenantId,
          after: {
            source: "import",
            message: errorChainMessage(error).slice(0, 500),
          },
        },
        this.tenantId,
      ).catch(() => undefined);
    }

    const okReceipts: ImportRowReceipt[] = checked.map((entry) => ({
      ok: true,
      kind: entry.kind,
      row: entry.row,
      key: entry.key,
    }));
    return buildResult({
      committed: true,
      batchError: null,
      totalRows,
      rows: okReceipts,
      importedCustomers: checked.filter((entry) => entry.kind === "customer").length,
      importedSamples: checked.filter((entry) => entry.kind === "fabric_sample").length,
      correlationId,
    });
  }

  /**
   * 重置模式：在同一事务内删除待替换的旧实体及其引用记录。
   * 引用记录仅限「引用了这些客户 / 样品」的报价与寄样单（连同明细），
   * 不触碰其它业务数据；每删一个旧实体都写同事务 `IMPORT_RESET` 审计。
   * 任何删除失败 => 整个事务回滚，旧数据与新导入都不会半途落库。
   */
  private async resetWithin(
    tx: Tx,
    existingCustomers: Map<string, string>,
    existingSamples: Map<string, string>,
    ctx: KernelContext,
  ): Promise<void> {
    const customerIds = [...existingCustomers.values()];
    const sampleIds = [...existingSamples.values()];
    if (customerIds.length === 0 && sampleIds.length === 0) return;

    const quoteIds = new Set<string>();
    const shipmentIds = new Set<string>();
    if (customerIds.length > 0) {
      const quoteRows = await tx
        .select({ id: quotes.id })
        .from(quotes)
        .where(and(inArray(quotes.customerId, customerIds), eq(quotes.tenantId, this.tenantId)));
      for (const row of quoteRows) quoteIds.add(row.id);
      const shipmentRows = await tx
        .select({ id: sampleShipments.id })
        .from(sampleShipments)
        .where(
          and(
            inArray(sampleShipments.customerId, customerIds),
            eq(sampleShipments.tenantId, this.tenantId),
          ),
        );
      for (const row of shipmentRows) shipmentIds.add(row.id);
    }
    if (sampleIds.length > 0) {
      const quoteRows = await tx
        .select({ id: quoteItems.quoteId })
        .from(quoteItems)
        .where(inArray(quoteItems.sampleId, sampleIds));
      for (const row of quoteRows) quoteIds.add(row.id);
      const shipmentRows = await tx
        .select({ id: sampleShipmentItems.shipmentId })
        .from(sampleShipmentItems)
        .where(inArray(sampleShipmentItems.sampleId, sampleIds));
      for (const row of shipmentRows) shipmentIds.add(row.id);
    }

    // 先删引用记录（明细 → 主单），再删客户上下文 / 样品向量，最后删主实体。
    if (quoteIds.size > 0) {
      const ids = [...quoteIds];
      await tx.delete(quoteItems).where(inArray(quoteItems.quoteId, ids));
      await tx.delete(quotes).where(inArray(quotes.id, ids));
      for (const id of ids) {
        await appendAudit(
          tx,
          ctx,
          { action: "IMPORT_RESET", entityType: "quote", entityId: id },
          this.tenantId,
        );
      }
    }
    if (shipmentIds.size > 0) {
      const ids = [...shipmentIds];
      await tx.delete(sampleShipmentItems).where(inArray(sampleShipmentItems.shipmentId, ids));
      await tx.delete(sampleShipments).where(inArray(sampleShipments.id, ids));
      for (const id of ids) {
        await appendAudit(
          tx,
          ctx,
          {
            action: "IMPORT_RESET",
            entityType: "sample_shipment",
            entityId: id,
          },
          this.tenantId,
        );
      }
    }
    if (customerIds.length > 0) {
      await tx.delete(customerContexts).where(inArray(customerContexts.customerId, customerIds));
      await tx.delete(customers).where(inArray(customers.id, customerIds));
      for (const [code, id] of existingCustomers) {
        await appendAudit(
          tx,
          ctx,
          {
            action: "IMPORT_RESET",
            entityType: "customer",
            entityId: id,
            before: { code },
          },
          this.tenantId,
        );
      }
    }
    if (sampleIds.length > 0) {
      await tx
        .delete(sampleTextEmbeddings)
        .where(inArray(sampleTextEmbeddings.sampleId, sampleIds));
      await tx.delete(samples).where(inArray(samples.id, sampleIds));
      for (const [code, id] of existingSamples) {
        await appendAudit(
          tx,
          ctx,
          {
            action: "IMPORT_RESET",
            entityType: "fabric_sample",
            entityId: id,
            before: { code },
          },
          this.tenantId,
        );
      }
    }
  }
}
