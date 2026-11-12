import { randomUUID } from "node:crypto";
import { customers, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
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
import { inArray } from "drizzle-orm";
import type { KernelContext } from "./audit";
import type { CustomerService } from "./customers.service";
import { errorChainMessage } from "./errors";
import type { EmbeddingProvider } from "../platform/embedding";
import { sampleEmbeddingText } from "./sample-embedding-text";
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
 * sample_embeddings / audit_log）的唯一批量写入者。
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
    private readonly embedder: EmbeddingProvider,
  ) {}

  async execute(input: unknown, ctx: KernelContext): Promise<ImportResult> {
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
        .where(inArray(customers.code, customerCodes));
      for (const row of rows) existingCustomers.set(row.code, row.id);
    }
    if (sampleCodes.length > 0) {
      const rows = await this.db
        .select({ id: samples.id, code: samples.code })
        .from(samples)
        .where(inArray(samples.code, sampleCodes));
      for (const row of rows) existingSamples.set(row.code, row.id);
    }
    const checked: ValidatedRow[] = [];
    for (const entry of deduped) {
      const code = entry.kind === "customer" ? entry.customer.code : entry.sample.code;
      const map = entry.kind === "customer" ? existingCustomers : existingSamples;
      const existingId = map.get(code);
      if (existingId !== undefined) {
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

    // ⑥ 单事务原子写入（向量在事务前算好，避免半开事务）
    const correlationId = randomUUID();
    const fullCtx: KernelContext = { ...ctx, correlationId };
    const embeddings = new Map<ValidatedSample, number[]>();
    try {
      for (const entry of checked) {
        if (entry.kind === "fabric_sample") {
          const embedding = await this.embedder.embedText(
            sampleEmbeddingText({
              code: entry.sample.code,
              name: entry.sample.name,
              composition: entry.sample.composition ?? null,
              weight: entry.sample.weight ?? null,
            }),
          );
          embeddings.set(entry, embedding);
        }
      }
      await this.db.transaction(async (tx) => {
        for (const entry of checked) {
          if (entry.kind === "customer") {
            await this.customerService.insertWithin(tx, entry.customer, fullCtx, entry.context);
          } else {
            const embedding = embeddings.get(entry);
            if (!embedding) throw new Error("样品向量缺失，拒绝写入");
            await this.sampleService.insertWithin(tx, entry.sample, fullCtx, embedding);
          }
        }
      });
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

    // ⑦ 提交成功
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
}
