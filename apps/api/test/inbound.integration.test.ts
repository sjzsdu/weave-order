import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";
import type { OcrGateway, OcrRecognizeInput, OcrRecognizeResult } from "../src/platform/ocr";
import { OcrError } from "../src/platform/ocr";
import type { ObjectStorage } from "../src/platform/storage";

/**
 * 统一输入集成测试（真实 PostgreSQL）。
 *
 * 覆盖三条验收里最容易被「看起来成功」骗过的：
 * 1. 同 clientRequestId 重复提交只有一条 inbound 与一组原件；
 * 2. revise 改 kind 后按新 kind 执行；
 * 3. 重复执行不重复建客户/样品（sourceId 幂等）。
 *
 * OCR 用确定性假实现，不联网；没有本地 PG 时整组跳过。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let pool: Pool | null = null;
let kernel: Kernel | null = null;
let available = false;
let tenantId = "";

const ctx: KernelContext = {
  actor: { type: "HUMAN", id: "inbound-it-member", role: "OWNER" },
};

const storage = {
  get: () => Promise.resolve({ contentType: "image/jpeg", bytes: Buffer.from("fake-image") }),
  presignPut: () => Promise.resolve("http://example.test/put"),
  signGet: () => Promise.resolve("http://example.test/get"),
  head: () => Promise.resolve(null),
  put: () => Promise.resolve(undefined),
  delete: () => Promise.resolve(undefined),
} as unknown as ObjectStorage;

function fakeOcr(options: { fail?: boolean }): OcrGateway {
  return {
    name: "fake-route-b",
    recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
      if (options.fail) return Promise.reject(new OcrError("LOW_CONFIDENCE", "图片太模糊"));
      if (input.kind === "bizcard") {
        return Promise.resolve({
          text: "杭州青禾服饰有限公司 张三 经理 13800138000 主营 面料",
          fields: {
            company: "杭州青禾服饰有限公司",
            contact: "张三",
            title: "经理",
            phone: "13800138000",
            tel: "",
            address: "杭州市余杭区",
            business: "面料",
            email: "zhang@example.com",
          },
          engine: "fake",
          raw: {},
          latencyMs: 1,
        });
      }
      return Promise.resolve({
        text: "100% 棉 220g 150cm 批号 A-2026",
        fields: {
          product: "32S 精梳棉",
          composition: "100% 棉",
          gsm: "220",
          width: "150",
          lot: "A-2026",
          supplier: "绍兴某纺织",
        },
        engine: "fake",
        raw: {},
        latencyMs: 1,
      });
    },
  };
}

function ctxOf(): KernelContext {
  return { ...ctx, tenantId };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const probe = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.ocr_results') IS NOT NULL AND to_regclass('public.items') IS NOT NULL AS exists",
    );
    available = probe.rows[0]?.exists === true;
  } catch {
    available = false;
  }
  if (!available) return;
  tenantId = `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
  const db: Db = createDb(DATABASE_URL).db;
  kernel = createKernel(db, undefined, { tenantId, storage, ocrGateway: fakeOcr({}) });
});

afterAll(async () => {
  if (pool && available) {
    const tables = [
      "items",
      "ocr_results",
      "sources",
      "resource_fields",
      "customer_contacts",
      "customer_contexts",
      "customers",
      "samples",
      "audit_log",
      "intents",
    ];
    for (const table of tables) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]).catch(() => {});
    }
  }
  await pool?.end();
});

async function submitOnce(clientRequestId: string, text = "拍名片建档") {
  if (!kernel) throw new Error("kernel 未初始化");
  return kernel.inbound.submit(
    {
      text,
      source: "upload",
      clientRequestId,
      attachments: [
        {
          objectKey: `tenant/${tenantId}/inbound/fake.jpg`,
          mimeType: "image/jpeg",
          kind: "bizcard",
        },
      ],
    },
    ctxOf(),
  );
}

describe("统一输入幂等", () => {
  it("同一 clientRequestId 重复提交只产生一条 inbound 与一组原件", async () => {
    if (!available || !kernel || !pool) return;
    const first = await submitOnce("client-req-idempotent-1");
    const second = await submitOnce("client-req-idempotent-1");
    expect(second.inboundId).toBe(first.inboundId);
    expect(second.created).toBe(false);

    const intents = await pool.query(
      "SELECT id FROM intents WHERE tenant_id = $1 AND client_request_id = $2",
      [tenantId, "client-req-idempotent-1"],
    );
    expect(intents.rowCount).toBe(1);
    const sources = await pool.query("SELECT id FROM sources WHERE id = ANY($1::uuid[])", [
      first.intent.attachments,
    ]);
    expect(sources.rowCount).toBe(2); // 一张图 + 一段文本各一条原件
  });

  it("重复理解不重复写 OCR 行", async () => {
    if (!available || !kernel || !pool) return;
    const submitted = await submitOnce("client-req-idempotent-2");
    await kernel.inbound.understand(submitted.inboundId);
    await kernel.inbound.understand(submitted.inboundId);
    const rows = await pool.query(
      "SELECT id FROM ocr_results WHERE tenant_id = $1 AND source_id = ANY($2::uuid[])",
      [tenantId, (await kernel.intent.getRow(submitted.inboundId)).attachments],
    );
    expect(rows.rowCount).toBe(1);
  });
});

describe("理解卡与执行", () => {
  it("名片理解成建客户；执行两次只建一个客户草稿", async () => {
    if (!available || !kernel || !pool) return;
    const submitted = await submitOnce("client-req-exec-1");
    const understood = await kernel.inbound.understand(submitted.inboundId);
    expect(understood.understanding?.kind).toBe("customer");
    expect(understood.understanding?.fields.find((f) => f.fieldName === "business")?.value).toBe(
      "",
    );

    await kernel.inbound.start(submitted.inboundId, {}, ctxOf());
    await kernel.inbound.execute(submitted.inboundId, ctxOf());
    await kernel.inbound.execute(submitted.inboundId, ctxOf());

    const rows = await pool.query(
      "SELECT id FROM customers WHERE tenant_id = $1 AND draft_source_id = $2",
      [tenantId, understood.attachments[0]?.sourceId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("kind 判错时通过 revise 改成建样品，补齐品名后可执行", async () => {
    if (!available || !kernel || !pool) return;
    const submitted = await submitOnce("client-req-exec-2");
    await kernel.inbound.understand(submitted.inboundId);

    const revised = await kernel.inbound.revise(submitted.inboundId, { kind: "sample" });
    expect(revised.understanding?.kind).toBe("sample");
    expect(revised.intent.status).toBe("NEEDS_INPUT");

    const filled = await kernel.inbound.revise(submitted.inboundId, {
      fields: [{ fieldName: "name", value: "32S 精梳棉" }],
    });
    expect(filled.intent.status).toBe("SUCCEEDED");

    await kernel.inbound.start(submitted.inboundId, {}, ctxOf());
    const result = await kernel.inbound.execute(submitted.inboundId, ctxOf());
    expect(result.outcomes[0]?.status).toBe("SUCCEEDED");
    const rows = await pool.query("SELECT id FROM samples WHERE tenant_id = $1 AND name = $2", [
      tenantId,
      "32S 精梳棉",
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it("OCR 失败时进入 NEEDS_INPUT，字段留空；人工补齐后继续成功", async () => {
    if (!available || !pool) return;
    const failingKernel = createKernel(createDb(DATABASE_URL).db, undefined, {
      tenantId,
      storage,
      ocrGateway: fakeOcr({ fail: true }),
    });
    const submitted = await failingKernel.inbound.submit(
      {
        text: "拍名片建档",
        source: "mobile-camera",
        clientRequestId: "client-req-ocr-fail-1",
        attachments: [
          {
            objectKey: `tenant/${tenantId}/inbound/fail.jpg`,
            mimeType: "image/jpeg",
            kind: "bizcard",
          },
        ],
      },
      ctxOf(),
    );
    const understood = await failingKernel.inbound.understand(submitted.inboundId);
    expect(understood.intent.status).toBe("NEEDS_INPUT");
    expect(understood.understanding?.fields.every((field) => field.value === "")).toBe(true);

    const filled = await failingKernel.inbound.revise(submitted.inboundId, {
      fields: [{ fieldName: "name", value: "手工补的客户" }],
    });
    expect(filled.intent.status).toBe("SUCCEEDED");
    await failingKernel.inbound.start(submitted.inboundId, {}, ctxOf());
    const result = await failingKernel.inbound.execute(submitted.inboundId, ctxOf());
    expect(result.outcomes[0]?.status).toBe("SUCCEEDED");
    expect(result.outcomes[0]?.resourceId).toBeTruthy();
  });
});
