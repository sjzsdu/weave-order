import { createDb, printJobs, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrintTemplateLayout } from "@weave-order/schema";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";
import { SampleCardService } from "../src/kernel/print/sample-card.service";
import { PrintJobService } from "../src/kernel/print/print-jobs.service";
import { PrintTemplateService } from "../src/kernel/print/print-templates.service";
import { PrintViewService } from "../src/kernel/print/print-view.service";
import { requirePrintTestEnv } from "./support/print-env";

/**
 * P0c 模板编辑闭环（真连 PG）：
 * 复制系统样卡 → 存草稿 → 发版本 → 再改再发 → 回滚 → 打印次数统计。
 *
 * 钉死两件事：已发布版本一行不会被改写；试打任务不算正式打印记录。
 *
 * 每个用例都显式声明 30s 超时（与本目录其它 DB 用例一致）：
 * 这套件每个用例都要打十几次 PG，整仓 114 个测试文件并行跑时连接池互相排队，
 * 单个用例从本地的百来毫秒被拖到 CI 的秒级是常态（2026-11-22 实测首条 5008ms，
 * 撞上 vitest 默认的 5s 直接变红）。默认 5s 是给纯单元用例的，
 * 拿它卡真连库的重用例就是假红灯——超时该放宽到用例自己身上，不是全局配置上。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const OWNER: KernelContext = {
  actor: { type: "HUMAN", id: "template-editor-owner", role: "OWNER" },
};
const SALES: KernelContext = {
  actor: { type: "HUMAN", id: "template-editor-sales", role: "SALES" },
};
const QUOTE_ID = "44444444-4444-4444-8444-444444444444";

let db: Db | null = null;
let available = false;
let tenantId = "";
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function services() {
  if (!db) throw new Error("数据库不可用");
  const templates = new PrintTemplateService(db, tenantId);
  const sampleCards = new SampleCardService(
    db,
    tenantId,
    { shareSecret: "test-secret", publicAppUrl: "https://weave.test" },
    templates,
  );
  const jobs = new PrintJobService(
    db,
    tenantId,
    new PrintViewService(db, tenantId),
    templates,
    sampleCards,
  );
  return { templates, jobs };
}

/** 试打要真实报价数据：建一个租户 + 一份已确认报价。 */
async function seedQuoteTenant() {
  if (!db) throw new Error("数据库不可用");
  await db
    .update(tenants)
    .set({
      settings: { brand: "织序 WEAVE", salesContact: { name: "孙巨中", phone: "13800000000" } },
    })
    .where(eq(tenants.id, tenantId));
  return { kernel: createKernel(db, undefined, { tenantId }) };
}

async function seedConfirmedQuote(kernel: Kernel): Promise<string> {
  const id = suffix();
  const customer = await kernel.customers.create({ code: `TE-C-${id}`, name: "青禾服饰" }, OWNER);
  const sample = await kernel.samples.create(
    {
      code: `TE-S-${id}`,
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
  const draft = await kernel.quotes.createForItem(
    item.item!.id,
    { unitPrice: { amount: 1800, currency: "CNY" }, validityDays: 14 },
    OWNER,
  );
  await kernel.quotes.confirmDraft(draft.draft.id, OWNER, draft.version, `confirm-${suffix()}`);
  return draft.draft.id;
}

function layoutHiding(field: string): PrintTemplateLayout {
  return {
    version: 1,
    blocks: [
      { field: "tenant.brand", label: null, visible: true, fontSize: 16, bold: true },
      { field: "sample.code", label: null, visible: true, fontSize: 26, bold: true },
      { field: "sample.name", label: null, visible: false, fontSize: 18, bold: false },
      { field: "salesperson.phone", label: null, visible: true, fontSize: 14, bold: false },
    ],
    qr: { visible: true, position: field === "none" ? "BOTTOM" : "RIGHT", sizeMm: 30 },
  };
}

beforeAll(async () => {
  try {
    const handle = createDb(DATABASE_URL);
    const check = await handle.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.print_jobs') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    db = handle.db;
    if (!available) {
      await handle.pool.end();
      return;
    }
    const rows = await handle.db
      .insert(tenants)
      .values({ slug: `template-editor-${suffix()}`, name: "模板编辑测试租户" })
      .returning();
    tenantId = rows[0]!.id;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  // 连接池由进程退出回收；测试数据按租户隔离，不清理也不影响其它用例。
});

describe("样卡模板编辑闭环", () => {
  it("复制系统样卡 → 草稿 → 发布版本 → 回滚 → 打印次数只算正式打印", async (ctx) => {
    if (!available) requirePrintTestEnv(ctx, "数据库不可用，无法验证模板编辑闭环");
    const { templates, jobs } = services();

    // 1. 复制系统 A4 样卡：草稿态，正式打印不受影响。
    const copied = await templates.copyFromSystem(
      { sourceTemplateId: "system/sample-card/classic-a4", name: `我的样卡-${suffix()}` },
      OWNER,
    );
    expect(copied.template.hasDraft).toBe(true);
    expect(copied.template.versionCount).toBe(0);
    expect(copied.template.activeVersion).toBeNull();
    expect(copied.draft?.layout?.blocks.length).toBeGreaterThan(0);

    const templateId = copied.template.id;

    // 2. 修改版式：隐藏 sample.name，草稿正文里就不该再出现这个字段。
    const edited = await templates.saveDraft(
      templateId,
      { layout: layoutHiding("sample.name") },
      OWNER,
    );
    expect(edited.draft?.body).not.toContain("{{sample.name}}");
    expect(edited.draft?.body).toContain("{{sample.code}}");

    // 3. 发布第一版：草稿被消耗，版本 1 生效。
    const published = await templates.publishVersion(
      { templateId, layout: layoutHiding("sample.name"), changelog: "第一次改版" },
      OWNER,
    );
    expect(published.activeVersion?.version).toBe(1);
    expect(published.hasDraft).toBe(false);
    const v1 = (await templates.detail(templateId)).versions[0]!;
    expect(v1.version).toBe(1);

    // 4. 再改再发：v1 的正文一个字节都不能变，只能新增 v2。
    await templates.saveDraft(templateId, { layout: layoutHiding("none") }, OWNER);
    await templates.publishVersion(
      { templateId, layout: layoutHiding("none"), changelog: "二维码挪到下面" },
      OWNER,
    );
    const afterSecond = await templates.detail(templateId);
    expect(afterSecond.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(afterSecond.versions[1]!.body).toBe(v1.body);
    expect(afterSecond.versions[1]!.publishedAt).toBe(v1.publishedAt);

    // 5. 回滚到 v1：只切当前版本指针，版本行不动。
    const rolledBack = await templates.activateVersion(templateId, v1.id, OWNER);
    expect(rolledBack.template.activeVersion?.id).toBe(v1.id);
    expect(rolledBack.versions).toHaveLength(2);
    expect(rolledBack.versions[1]!.body).toBe(v1.body);

    // 6. 打印次数只算正式打印：试打任务不进补打记录，也不算用量。
    await db!.insert(printJobs).values({
      tenantId,
      kind: "SAMPLE_LABEL",
      documentId: QUOTE_ID,
      templateId,
      templateVersionId: v1.id,
      templateVersion: 1,
      format: "HTML",
      copies: 1,
      status: "DONE",
      isTest: false,
      idempotencyKey: `official-${suffix()}`,
      payload: "pdf",
      requestedBy: OWNER.actor.id,
    });
    await db!.insert(printJobs).values({
      tenantId,
      kind: "SAMPLE_LABEL",
      documentId: QUOTE_ID,
      templateId,
      templateVersionId: v1.id,
      templateVersion: 1,
      format: "HTML",
      copies: 1,
      status: "DONE",
      isTest: true,
      idempotencyKey: `test-${suffix()}`,
      payload: "pdf",
      requestedBy: OWNER.actor.id,
    });

    const counted = await templates.detail(templateId);
    expect(counted.versions.find((version) => version.id === v1.id)?.printCount).toBe(1);

    const history = await jobs.listForQuote(QUOTE_ID);
    expect(history).toHaveLength(1);
    expect(history[0]?.isTest).toBe(false);
  }, 30_000);

  it("非法字段被拒绝：版式只能从白名单里选", async (ctx) => {
    if (!available) requirePrintTestEnv(ctx, "数据库不可用，无法验证白名单");
    const { templates } = services();
    const copied = await templates.copyFromSystem(
      { sourceTemplateId: "system/sample-card/classic-a4", name: `白名单-${suffix()}` },
      OWNER,
    );
    await expect(
      templates.saveDraft(
        copied.template.id,
        {
          layout: {
            version: 1,
            blocks: [{ field: "order.no", label: null, visible: true, fontSize: 14, bold: false }],
            qr: { visible: false, position: "RIGHT", sizeMm: 30 },
          },
        },
        OWNER,
      ),
    ).rejects.toThrowError(/order\.no/);
  }, 30_000);

  it("HTML 版式只有 OWNER 能碰草稿：SALES 复制 A4 样卡被拒，复制标签可以", async (ctx) => {
    if (!available) requirePrintTestEnv(ctx, "数据库不可用，无法验证 HTML 能力边界");
    const { templates } = services();

    await expect(
      templates.copyFromSystem(
        { sourceTemplateId: "system/sample-card/classic-a4", name: `销售A4-${suffix()}` },
        SALES,
      ),
    ).rejects.toThrowError(/HTML 打印模板只能由 OWNER 发布/);

    const labelCopy = await templates.copyFromSystem(
      { sourceTemplateId: "system/sample-card/zpl-80x50", name: `销售标签-${suffix()}` },
      SALES,
    );
    expect(labelCopy.draft?.layout).not.toBeNull();
    await expect(
      templates.saveDraft(labelCopy.template.id, { layout: layoutHiding("sample.name") }, SALES),
    ).resolves.toBeTruthy();
  }, 30_000);

  it("租户的文本模板不能被「复制成可视化模板」：否则正文会丢", async (ctx) => {
    if (!available) requirePrintTestEnv(ctx, "数据库不可用，无法验证复制来源校验");
    const { templates } = services();
    const published = await templates.publish(
      {
        kind: "SAMPLE_LABEL",
        scope: "COMPANY",
        name: `文本样卡-${suffix()}`,
        format: "ZPL",
        body: "^XA^FO20,20^A0N,30,30^FD{{sample.code}}^FS^XZ",
      },
      OWNER,
    );
    await expect(
      templates.copyFromSystem(
        { sourceTemplateId: published.id, name: `复制文本-${suffix()}` },
        OWNER,
      ),
    ).rejects.toThrowError(/文本模板/);
  }, 30_000);

  it("版本打印次数只算已完成的正式打印：FAILED 与试打都不算", async (ctx) => {
    if (!available) requirePrintTestEnv(ctx, "数据库不可用，无法验证打印次数口径");
    const { templates } = services();
    const copied = await templates.copyFromSystem(
      { sourceTemplateId: "system/sample-card/classic-a4", name: `计数-${suffix()}` },
      OWNER,
    );
    const published = await templates.publishVersion(
      { templateId: copied.template.id, layout: layoutHiding("sample.name") },
      OWNER,
    );
    const versionId = published.activeVersion!.id;
    const base = {
      tenantId,
      kind: "SAMPLE_LABEL" as const,
      documentId: QUOTE_ID,
      templateId: copied.template.id,
      templateVersionId: versionId,
      templateVersion: 1,
      format: "HTML" as const,
      copies: 1,
      payload: "pdf",
      requestedBy: OWNER.actor.id,
    };
    await db!.insert(printJobs).values([
      { ...base, status: "DONE", isTest: false, idempotencyKey: `done-${suffix()}` },
      { ...base, status: "FAILED", isTest: false, idempotencyKey: `failed-${suffix()}` },
      { ...base, status: "DONE", isTest: true, idempotencyKey: `test-${suffix()}` },
    ]);
    const detail = await templates.detail(copied.template.id);
    expect(detail.versions[0]?.printCount).toBe(1);
  }, 30_000);

  it("可视化编辑只对样卡开放：其它单据仍走文本模板", async (ctx) => {
    if (!available) requirePrintTestEnv(ctx, "数据库不可用，无法验证范围");
    const { templates } = services();
    await expect(
      templates.copyFromSystem(
        { sourceTemplateId: "system/delivery-note/classic", name: `发货单-${suffix()}` },
        OWNER,
      ),
    ).rejects.toThrowError(/还不能可视化编辑/);
  }, 30_000);

  it("试打真的入队，但不进正式打印记录、也不算版本用量", async (ctx) => {
    if (!available) requirePrintTestEnv(ctx, "数据库不可用，无法验证试打隔离");
    const { kernel } = await seedQuoteTenant();
    const jobTemplate = await kernel.print.templates.copyFromSystem(
      { sourceTemplateId: "system/sample-card/classic-a4", name: `试打-${suffix()}` },
      OWNER,
    );
    await kernel.print.templates.publishVersion(
      { templateId: jobTemplate.template.id, layout: layoutHiding("sample.name") },
      OWNER,
    );

    const quoteId = await seedConfirmedQuote(kernel);
    const result = await kernel.print.jobs.testPrintSampleCard(
      jobTemplate.template.id,
      { quoteId, lineIndex: 0, format: "HTML" },
      OWNER,
    );
    expect(result.job.isTest).toBe(true);
    expect(result.job.status).toBe("QUEUED");

    // 正式记录（打印抽屉的补打入口）里看不到试打；版本用量也不含它。
    expect(await kernel.print.jobs.listForQuote(quoteId)).toHaveLength(0);
    const detail = await kernel.print.templates.detail(jobTemplate.template.id);
    expect(detail.versions[0]?.printCount).toBe(0);

    // 试打不构成「打印过」：没有正式任务时补打应被拒绝。
    await expect(
      kernel.print.jobs.reprintSampleCard(quoteId, { reason: "DAMAGED", lineIndex: 0 }, OWNER),
    ).rejects.toThrowError(/还没有打印过/);

    const rows = await db!
      .select({ id: printJobs.id, isTest: printJobs.isTest })
      .from(printJobs)
      .where(
        and(eq(printJobs.tenantId, tenantId), eq(printJobs.templateId, jobTemplate.template.id)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isTest).toBe(true);
  }, 30_000);
});
