/**
 * E2E persona 数据夹具（WAN-136）。
 *
 * 只做两件事：
 *  1. 按 persona 目录幂等 seed 7 个成员（与 `pnpm seed` 同一个 `ensureDemoIdentity`）；
 *  2. 确保一条「挂在演示业务员名下」的客户，用来断言
 *     「经理（TEAM）能看到业务员（OWN）的客户」。
 *
 * 输出最后一行是 JSON，由 `e2e/support/seed.ts` 读取；日志走 stderr，
 * 避免污染夹具载荷。禁止在生产/测试环境运行：`ensureDemoIdentity` 会写 memberships。
 */
import { createDb, customers } from "@weave-order/db";
import { PERSONAS } from "@weave-order/schema";
import { and, eq } from "drizzle-orm";
import { ensureDemoIdentity, demoWriteContext } from "./demo-identity";
import { createKernel } from "../src/kernel";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const CUSTOMER_CODE = process.env.E2E_PERSONA_CUSTOMER_CODE ?? "E2E-PERSONA-001";
const CUSTOMER_NAME = "E2E 业务员客户（persona 夹具）";

async function main(): Promise<void> {
  const handle = createDb(DATABASE_URL);
  try {
    const identity = await ensureDemoIdentity(handle.db);
    const existing = await handle.db
      .select({ id: customers.id, code: customers.code, name: customers.name })
      .from(customers)
      .where(and(eq(customers.tenantId, identity.tenantId), eq(customers.code, CUSTOMER_CODE)))
      .limit(1);

    if (existing.length === 0) {
      const kernel = createKernel(handle.db, undefined, { tenantId: identity.tenantId });
      await kernel.customers.create(
        { code: CUSTOMER_CODE, name: CUSTOMER_NAME },
        // 归属演示业务员：SALES（OWN）与同队 MANAGER（TEAM）都能看到。
        demoWriteContext(identity, "e2e-persona-fixture"),
      );
      console.error(`  ✔ 已创建 persona 夹具客户 ${CUSTOMER_CODE}`);
    }

    const sales = PERSONAS.find((persona) => persona.key === "sales");
    const manager = PERSONAS.find((persona) => persona.key === "manager");
    if (!sales || !manager) throw new Error("persona 目录缺少 sales/manager");

    // 最后一行供 e2e 解析；stdout 只放这一行。
    console.log(
      JSON.stringify({
        tenantId: identity.tenantId,
        customerCode: CUSTOMER_CODE,
        customerName: CUSTOMER_NAME,
        salesSubject: sales.subject,
        managerSubject: manager.subject,
        salesTeamId: sales.teamId,
        managerTeamId: manager.teamId,
      }),
    );
  } finally {
    await handle.pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
