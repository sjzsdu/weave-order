/**
 * 样卡验收脚本（不进入产品依赖）：
 * 用真实报价数据跑通「确认报价 → 预览 → 入队」，把预览产物落到磁盘，
 * 供人工比对「预览 = 产物」。实物打印验证时，直接用这里生成的 preview.pdf
 * 与 label.zpl 送打印机即可，不需要再造一遍数据。
 *
 * 用法：pnpm --filter @weave-order/api verify:sample-card [outDir]
 * 默认输出到 apps/api/.artifacts/sample-card。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDb } from "@weave-order/db";
import { weightLabel } from "@weave-order/schema";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";
import { buildSampleCardUrl, createSampleCardToken } from "../src/kernel/share-token";
import { renderSampleCardText, sampleCardValues } from "../src/kernel/print/sample-card";
import { SYSTEM_TEMPLATES } from "../src/kernel/print/templates";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const OWNER: KernelContext = {
  actor: { type: "HUMAN", id: "sample-card-artifacts", role: "OWNER" },
};
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "sample-card-artifacts" } };

async function main() {
  const outDir = path.resolve(process.argv[2] ?? ".artifacts/sample-card");
  await mkdir(outDir, { recursive: true });

  const handle = createDb(DATABASE_URL);
  const db = handle.db;
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const bootstrap = createKernel(db);
  const tenant = await bootstrap.tenancy.createTenant(
    { slug: `card-artifacts-${suffix}`, name: "织序纺织", casdoorOrg: `card-artifacts-${suffix}` },
    SYSTEM,
  );
  await handle.pool.query(
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
  const customer = await kernel.customers.create(
    { code: `ART-C-${suffix}`, name: "青禾服饰有限公司" },
    OWNER,
  );
  const sample = await kernel.samples.create(
    {
      code: `FM-220-${suffix.slice(0, 4).toUpperCase()}`,
      name: "32S 精梳棉汗布",
      composition: "100% 精梳棉",
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
    { unitPrice: { amount: 1800, currency: "CNY" }, validityDays: 30 },
    OWNER,
  );
  await kernel.quotes.confirmDraft(draft.draft.id, OWNER, draft.version, `art-${suffix}`);

  const a4 = await kernel.print.sampleCards.preview(
    { quoteId: draft.draft.id, format: "HTML" },
    "sample-card-artifacts",
  );
  const label = await kernel.print.sampleCards.preview(
    { quoteId: draft.draft.id, format: "ZPL" },
    "sample-card-artifacts",
  );
  const jobs = await kernel.print.jobs.printSampleCards(draft.draft.id, { format: "HTML" }, OWNER);

  await writeFile(path.join(outDir, "preview.html"), a4.html ?? "", "utf8");
  await writeFile(path.join(outDir, "preview.pdf"), Buffer.from(a4.pdfBase64 ?? "", "base64"));
  await writeFile(path.join(outDir, "label.zpl"), label.text ?? "", "utf8");

  /**
   * 连续 40 张标签：给实物验收与「二维码逐张可解码」提供现成物料。
   * 只生成 ZPL，不含渲染/解码——渲染与解码方法见 docs/acceptance/wan-198/README.md。
   */
  const publicAppUrl = process.env.PUBLIC_APP_URL ?? "http://localhost:5174";
  const secret = process.env.QUOTE_SHARE_SECRET ?? "dev-only-quote-share-secret-change-me-0001";
  const zplTemplate = SYSTEM_TEMPLATES.find(
    (template) => template.kind === "SAMPLE_LABEL" && template.format === "ZPL",
  )!;
  const names = ["32S 精梳棉汗布", "40S 双面羊毛呢", "16S 竹节棉卫衣布", "全消光尼龙塔丝隆"];
  const labelsDir = path.join(outDir, "labels");
  await mkdir(labelsDir, { recursive: true });
  const batch: Array<{ code: string; qrPayload: string; file: string }> = [];
  for (let index = 1; index <= 40; index += 1) {
    const code = `FM-${String(index).padStart(3, "0")}-${String.fromCharCode(65 + (index % 26))}`;
    const qrPayload = buildSampleCardUrl(
      publicAppUrl,
      createSampleCardToken({ tenantId: tenant.id, sampleCode: code }, secret),
    );
    const zpl = renderSampleCardText(
      zplTemplate.body,
      sampleCardValues({
        quoteNo: draft.quoteNumber ?? "",
        sample: {
          code,
          name: names[index % names.length]!,
          composition: sample.composition ?? null,
          weight: weightLabel(sample.weight),
          category: sample.category ?? null,
        },
        tenant: { name: tenant.name ?? "", brand: null },
        salesperson: { name: "孙巨中", phone: "13800000000" },
        qrPayload,
        qrImageDataUrl: "",
        printedAt: "2026-11-21 08:30",
        operator: "owner",
        reprintReason: null,
      }),
      "ZPL",
    );
    const file = path.join(labelsDir, `label-${String(index).padStart(2, "0")}.zpl`);
    await writeFile(file, zpl, "utf8");
    batch.push({ code, qrPayload, file });
  }
  await writeFile(path.join(outDir, "labels.json"), JSON.stringify(batch, null, 2), "utf8");
  await writeFile(
    path.join(outDir, "meta.json"),
    JSON.stringify(
      {
        tenantId: tenant.id,
        quoteId: draft.draft.id,
        quoteNumber: draft.quoteNumber,
        sampleCode: sample.code,
        qrPayload: a4.qrPayload,
        jobId: jobs.jobs[0]?.id,
        jobStatus: jobs.jobs[0]?.status,
        format: a4.format,
        templateName: a4.templateName,
        pageSize: a4.pageSize,
        fields: a4.fields,
      },
      null,
      2,
    ),
    "utf8",
  );

  // 清理本次生成的数据；封面文件保留给人工比对。
  await handle.pool.query("DELETE FROM print_job_events WHERE tenant_id = $1", [tenant.id]);
  await handle.pool.query("DELETE FROM print_jobs WHERE tenant_id = $1", [tenant.id]);
  await handle.pool.query("DELETE FROM document_snapshots WHERE tenant_id = $1", [tenant.id]);
  await handle.pool.query("DELETE FROM quote_items WHERE tenant_id = $1", [tenant.id]);
  await handle.pool.query("DELETE FROM quotes WHERE tenant_id = $1", [tenant.id]);
  await handle.pool.query("DELETE FROM items WHERE tenant_id = $1", [tenant.id]);
  await handle.pool.query("DELETE FROM customer_contacts WHERE tenant_id = $1", [tenant.id]);
  await handle.pool.query("DELETE FROM customer_contexts WHERE tenant_id = $1", [tenant.id]);
  await handle.pool.query("DELETE FROM customers WHERE tenant_id = $1", [tenant.id]);
  await handle.pool.query("DELETE FROM samples WHERE tenant_id = $1", [tenant.id]);
  await handle.pool.query("DELETE FROM tenants WHERE id = $1", [tenant.id]);
  await handle.pool.end();

  if (publicAppUrl.includes("localhost") || publicAppUrl.includes("127.0.0.1")) {
    console.warn(
      `[警告] PUBLIC_APP_URL=${publicAppUrl} 是本地地址：产物二维码在手机上打不开。` +
        "出实物验收件前请设为公网可达的报价站点地址。",
    );
  }
  console.log(`artifacts written to ${outDir}`);
  console.log(`quote=${draft.quoteNumber} sample=${sample.code} qr=${a4.qrPayload}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
