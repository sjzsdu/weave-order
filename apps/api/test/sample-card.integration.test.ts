import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, samples as samplesTable } from "@weave-order/db";
import { eq } from "drizzle-orm";
import type { Db } from "@weave-order/db";
import { createKernel, isKernelError } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";
import { PrintError } from "../src/print";
import { PublicSampleCardService } from "../src/shares/public-sample-card.service";

/**
 * P0b 样卡（真实 PG）：
 * - 未确认报价不能出卡；
 * - 预览与入队产物一致（A4 PDF 是真 PDF，标签是 ZPL 指令）；
 * - 幂等：同一操作人重复点打印只有一条任务；补打新增任务但不新增样品；
 * - 独立样品标签按 sampleId 直接出纸，不依赖报价；
 * - 二维码公开面展示样品属性与业务员联系方式，不带客户/价格/成本。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const OWNER: KernelContext = { actor: { type: "HUMAN", id: "sample-card-owner", role: "OWNER" } };
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "sample-card-bootstrap" } };

let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.print_jobs') IS NOT NULL AND to_regclass('public.quotes') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (available) db = createDb(DATABASE_URL).db;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (pool && available && createdTenants.length > 0) {
    await pool.query("DELETE FROM print_job_events WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM print_jobs WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM document_snapshots WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM printers WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM print_agents WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM quote_items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM quotes WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM customer_contacts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customer_contexts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM samples WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await pool?.end();
});

async function isolatedTenant(label: string) {
  if (!db) throw new Error("数据库不可用");
  const owner = createKernel(db);
  const tenant = await owner.tenancy.createTenant(
    { slug: `card-${label}-${suffix()}`, name: "织序纺织（测试）", casdoorOrg: `card-${label}` },
    SYSTEM,
  );
  createdTenants.push(tenant.id);
  await pool!.query(
    "UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb WHERE id = $1",
    [
      tenant.id,
      JSON.stringify({
        brand: "织序 WEAVE",
        salesContact: { name: "孙巨中", phone: "13800000000" },
      }),
    ],
  );
  const kernel = createKernel(db, undefined, { tenantId: tenant.id });
  return { tenant, kernel };
}

async function seedConfirmedQuote(kernel: Kernel, sampleCode?: string) {
  const id = suffix();
  const customer = await kernel.customers.create(
    { code: `CARD-C-${id}`, name: "青禾服饰（不应出现在样卡）" },
    OWNER,
  );
  const sample = await kernel.samples.create(
    {
      code: sampleCode ?? `CARD-S-${id}`,
      name: "32S 精梳棉汗布",
      composition: "100% 棉",
      weight: { value: 220, unit: "gsm" },
      category: "汗布",
      unit: "meter",
      costFloor: { amount: 1200, currency: "CNY" },
    },
    OWNER,
  );
  const item = await kernel.items.create(
    { customerId: customer.id, sampleId: sample.id, quantity: { value: 100, unit: "meter" } },
    OWNER,
  );
  const itemId = item.item!.id;
  const draft = await kernel.quotes.createForItem(
    itemId,
    { unitPrice: { amount: 1800, currency: "CNY" }, validityDays: 14 },
    OWNER,
  );
  return { customer, sample, itemId, draft };
}

describe("P0b 样卡打印", () => {
  it("未确认报价不能预览、也不能打印", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("draft");
    const { draft } = await seedConfirmedQuote(kernel);

    await expect(
      kernel.print.sampleCards.preview({ quoteId: draft.draft.id, format: "HTML" }, "owner"),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isKernelError(error) &&
        error.code === "KERNEL_REJECTED" &&
        error.details.reason === "PRINT_QUOTE_NOT_CONFIRMED",
    );
    await expect(
      kernel.print.jobs.printSampleCards(draft.draft.id, { format: "HTML" }, OWNER),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isKernelError(error) && error.details.reason === "PRINT_QUOTE_NOT_CONFIRMED",
    );
  });

  it("独立样品标签不需要报价：按 sampleId 预览、入队、查记录", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("sample-label");
    // 故意造一份未确认报价：独立标签不应被它挡住。
    const { sample } = await seedConfirmedQuote(kernel);

    const preview = await kernel.print.sampleCards.preview(
      { sampleId: sample.id, format: "ZPL" },
      "owner",
    );
    expect(preview.kind).toBe("SAMPLE_LABEL");
    expect(preview.quoteId).toBeNull();
    expect(preview.sampleId).toBe(sample.id);
    expect(preview.text).toContain(sample.code);
    expect(preview.text).toContain("^BQN");

    const result = await kernel.print.jobs.printSampleLabel(
      sample.id,
      { format: "ZPL", copies: 2 },
      OWNER,
    );
    expect(result.job.documentId).toBe(sample.id);
    expect(result.job.labelSeq).toBe(1);
    expect(await kernel.print.jobs.listForSample(sample.id)).toHaveLength(1);
  });

  it("独立标签按选中设备预览和出纸，切换打印机不会错误幂等去重", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("sample-label-printers");
    const { sample } = await seedConfirmedQuote(kernel);
    const registered = await kernel.print.devices.register({ name: `样卡代理-${suffix()}` }, OWNER);
    const agent = await kernel.print.devices.heartbeat(registered.agent.id, {
      printers: [
        {
          name: "ZPL 标签机",
          kind: "THERMAL",
          connection: "RAW_TCP",
          address: "192.168.1.50:9100",
          capabilities: { format: "ZPL" },
          calibration: {},
          status: "READY",
        },
        {
          name: "蓝牙标签机",
          kind: "BLUETOOTH",
          connection: "BLUETOOTH",
          address: null,
          capabilities: {},
          calibration: {},
          status: "READY",
        },
      ],
    });
    const zplPrinter = agent.printers.find((printer) => printer.name === "ZPL 标签机")!;
    const tsplPrinter = agent.printers.find((printer) => printer.name === "蓝牙标签机")!;

    const zplPreview = await kernel.print.jobs.previewSampleLabel(
      sample.id,
      { printerId: zplPrinter.id, format: "HTML" },
      OWNER.actor.id,
    );
    expect(zplPreview.format).toBe("ZPL");
    expect(zplPreview.text).toContain("^XA");
    expect(zplPreview.labelPreview).toMatchObject({ width: 640, height: 400 });

    const tsplPreview = await kernel.print.jobs.previewSampleLabel(
      sample.id,
      { printerId: tsplPrinter.id, format: "HTML" },
      OWNER.actor.id,
    );
    expect(tsplPreview.format).toBe("TSPL");
    expect(tsplPreview.text).toContain("SIZE 80 mm,50 mm");
    expect(tsplPreview.labelPreview).toMatchObject({ width: 640, height: 400 });

    const first = await kernel.print.jobs.printSampleLabel(
      sample.id,
      { printerId: zplPrinter.id, format: "HTML" },
      OWNER,
    );
    expect(first.job.format).toBe("ZPL");
    const duplicate = await kernel.print.jobs.printSampleLabel(
      sample.id,
      { printerId: zplPrinter.id, format: "HTML" },
      OWNER,
    );
    expect(duplicate).toMatchObject({ deduplicated: true, job: { id: first.job.id } });

    const switched = await kernel.print.jobs.printSampleLabel(
      sample.id,
      { printerId: tsplPrinter.id, format: "HTML" },
      OWNER,
    );
    expect(switched.deduplicated).toBe(false);
    expect(switched.job.id).not.toBe(first.job.id);
    expect(switched.job.format).toBe("TSPL");
    expect(switched.job.idempotencyKey).not.toBe(first.job.idempotencyKey);

    const reprint = await kernel.print.jobs.reprintSampleLabel(
      sample.id,
      { reason: "DAMAGED", printerId: zplPrinter.id, format: "HTML" },
      OWNER,
    );
    expect(reprint.job.format).toBe("ZPL");
    expect(await kernel.print.jobs.listForSample(sample.id)).toHaveLength(3);
  });

  it("独立样品标签未配置业务员电话时仍可预览并入队", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel, tenant } = await isolatedTenant("sample-label-no-phone");
    const { sample } = await seedConfirmedQuote(kernel);
    await pool!.query("UPDATE tenants SET settings = '{}'::jsonb WHERE id = $1", [tenant.id]);

    const preview = await kernel.print.sampleCards.preview(
      { sampleId: sample.id, format: "ZPL" },
      "owner",
    );
    expect(preview.text).toContain(sample.code);

    const result = await kernel.print.jobs.printSampleLabel(
      sample.id,
      { format: "ZPL", copies: 1 },
      OWNER,
    );
    expect(result.job.documentId).toBe(sample.id);
  });

  it("A4 预览就是打印产物；标签指令含二维码；二维码公开面展示样品属性", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("preview");
    const { draft, sample } = await seedConfirmedQuote(kernel);
    await kernel.quotes.confirmDraft(draft.draft.id, OWNER, draft.version, `confirm-${suffix()}`);

    const a4 = await kernel.print.sampleCards.preview(
      { quoteId: draft.draft.id, format: "HTML" },
      "owner",
    );
    expect(a4.format).toBe("HTML");
    expect(a4.labelPreview).toBeNull();
    expect(a4.sampleCode).toBe(sample.code);
    expect(a4.html).toContain(sample.code);
    expect(a4.html).not.toContain("青禾服饰");
    expect(
      Buffer.from(a4.pdfBase64 ?? "", "base64")
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    expect(a4.fields.map((field) => field.path)).toContain("salesperson.phone");
    expect(a4.fields.every((field) => !field.value.includes("青禾服饰"))).toBe(true);

    const label = await kernel.print.sampleCards.preview(
      { quoteId: draft.draft.id, format: "ZPL" },
      "owner",
    );
    expect(label.text).toContain("^BQN");
    expect(label.text).toContain(sample.code);
    expect(label.labelPreview?.elements).toContainEqual({
      type: "text",
      x: 24,
      y: 52,
      text: sample.code,
      fontSize: 30,
      bold: false,
    });
    expect(label.text).not.toContain("青禾服饰");
    expect(label.qrPayload).toBe(a4.qrPayload);

    // 扫码页展示样品属性与联系方式，但不带客户、价格或内部 UUID。
    const publicService = new PublicSampleCardService(pool!);
    const token = label.qrPayload.split("/").pop()!;
    const scanned = await publicService.view(token);
    expect(scanned).toEqual({
      sampleCode: sample.code,
      sample: {
        name: "32S 精梳棉汗布",
        composition: "100% 棉",
        color: null,
        weight: "220 g/m²",
        category: "汗布",
        imageUrl: null,
      },
      salesperson: { name: "孙巨中", phone: "13800000000" },
    });
    const serialized = JSON.stringify(scanned);
    expect(serialized).not.toContain("青禾");
    expect(serialized).not.toContain("1800");
    expect(Object.keys(scanned).sort()).toEqual(["salesperson", "sample", "sampleCode"]);
  });

  it("幂等：重复打印只有一条任务；补打新增任务但不新增样品", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("idem");
    const { draft, sample } = await seedConfirmedQuote(kernel);
    await kernel.quotes.confirmDraft(draft.draft.id, OWNER, draft.version, `confirm-${suffix()}`);

    const first = await kernel.print.jobs.printSampleCards(
      draft.draft.id,
      { format: "HTML", copies: 2 },
      OWNER,
    );
    expect(first.jobs).toHaveLength(1);
    expect(first.deduplicated).toHaveLength(0);
    expect(first.jobs[0]!.kind).toBe("SAMPLE_LABEL");
    expect(first.jobs[0]!.documentId).toBe(draft.draft.id);
    expect(first.jobs[0]!.copies).toBe(2);

    const second = await kernel.print.jobs.printSampleCards(
      draft.draft.id,
      { format: "HTML", copies: 2 },
      OWNER,
    );
    expect(second.deduplicated).toEqual([first.jobs[0]!.id]);
    expect(await kernel.print.jobs.listForQuote(draft.draft.id)).toHaveLength(1);

    const samplesBefore = await db!
      .select({ id: samplesTable.id })
      .from(samplesTable)
      .where(eq(samplesTable.tenantId, kernel.tenantId));
    const reprint = await kernel.print.jobs.reprintSampleCard(
      draft.draft.id,
      { reason: "DAMAGED", format: "HTML", copies: 1 },
      OWNER,
    );
    expect(reprint.deduplicated).toBe(false);
    expect(reprint.job.id).not.toBe(first.jobs[0]!.id);
    const jobs = await kernel.print.jobs.listForQuote(draft.draft.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.some((job) => job.reprintReason === "DAMAGED")).toBe(true);

    const samplesAfter = await db!
      .select({ id: samplesTable.id })
      .from(samplesTable)
      .where(eq(samplesTable.tenantId, kernel.tenantId));
    expect(samplesAfter.map((row) => row.id).sort()).toEqual(
      samplesBefore.map((row) => row.id).sort(),
    );

    // 任务详情可读，且载荷只在任务内。
    const detail = await kernel.print.jobs.get(reprint.job.id);
    expect(detail.id).toBe(reprint.job.id);
    expect(detail.labelSeq).toBe(1);
    expect(sample.code).toBeTruthy();
  });

  it("未配置业务员联系方式时显式报错，而不是打一张空白卡", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel, tenant } = await isolatedTenant("nocontact");
    const { draft } = await seedConfirmedQuote(kernel);
    await kernel.quotes.confirmDraft(draft.draft.id, OWNER, draft.version, `confirm-${suffix()}`);
    await pool!.query("UPDATE tenants SET settings = '{}'::jsonb WHERE id = $1", [tenant.id]);

    await expect(
      kernel.print.sampleCards.preview({ quoteId: draft.draft.id, format: "HTML" }, "owner"),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PrintError &&
        error.code === "PRINT_MISSING_FIELD" &&
        (error.detail.missing as string[]).includes("salesperson.phone"),
    );
  });

  it("设置里改业务员联系方式后，样卡与扫码页立即使用新名片", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("contact");
    const { draft } = await seedConfirmedQuote(kernel);
    await kernel.quotes.confirmDraft(draft.draft.id, OWNER, draft.version, `confirm-${suffix()}`);

    const saved = await kernel.shares.updateSalesContact(
      { name: "王芳", phone: "13900001111" },
      OWNER,
    );
    expect(saved).toEqual({ name: "王芳", phone: "13900001111" });
    expect(await kernel.shares.getSalesContact(OWNER)).toEqual({
      name: "王芳",
      phone: "13900001111",
    });

    const preview = await kernel.print.sampleCards.preview(
      { quoteId: draft.draft.id, format: "ZPL" },
      "owner",
    );
    expect(preview.text).toContain("王芳");
    expect(preview.text).toContain("13900001111");

    const token = preview.qrPayload.split("/").pop()!;
    const scanned = await new PublicSampleCardService(pool!).view(token);
    expect(scanned.salesperson).toEqual({ name: "王芳", phone: "13900001111" });

    // 审计留痕：谁能改、改成了什么。
    const audits = await pool!.query<{ actor_id: string; after: unknown }>(
      "SELECT actor_id, after FROM audit_log WHERE tenant_id = $1 AND action = 'SALES_CONTACT_UPDATED'",
      [kernel.tenantId],
    );
    expect(audits.rowCount).toBe(1);
    expect(audits.rows[0]?.actor_id).toBe(OWNER.actor.id);
  });

  it("样品编号含中文导致超字节上限时，是业务错误而不是 500", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("cjk-code");
    const code = "真丝面料真丝面料真丝面料"; // 12 字符 / 36 字节
    const { draft } = await seedConfirmedQuote(kernel, code);
    await kernel.quotes.confirmDraft(draft.draft.id, OWNER, draft.version, `confirm-${suffix()}`);

    await expect(
      kernel.print.sampleCards.preview({ quoteId: draft.draft.id, format: "HTML" }, "owner"),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PrintError &&
        error.code === "PRINT_FIELD_OVERFLOW" &&
        error.detail.path === "sample.code",
    );
  });

  it("跨租户拿不到别家的样卡", async (ctx) => {
    if (!available) ctx.skip();
    const tenantA = await isolatedTenant("iso-a");
    const tenantB = await isolatedTenant("iso-b");
    // 第二个租户的内核连的是同一个 db，但租户绑定不同。
    const { draft } = await seedConfirmedQuote(tenantA.kernel);
    await tenantA.kernel.quotes.confirmDraft(
      draft.draft.id,
      OWNER,
      draft.version,
      `confirm-${suffix()}`,
    );
    await expect(
      tenantB.kernel.print.sampleCards.preview(
        { quoteId: draft.draft.id, format: "HTML" },
        "owner",
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.code === "RESOURCE_NOT_FOUND",
    );
  });
});
