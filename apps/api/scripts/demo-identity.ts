/**
 * 演示 / seed 数据的归属人解析。
 *
 * 背景（WAN-106）：`dataScope` 默认 `OWN`，而 `customers.owner_id` 可空。
 * 如果 seed / demo 写入不带 `ownerId`，数据就挂成 NULL，`OWN` 成员永远看不到，
 * 演示环境登录后客户列表是空的。
 *
 * 因此演示数据统一挂到「演示业务员」成员（`SEED_SALES_SUBJECT`）：
 *  - 验收要求 `dataScope=OWN` 的 SALES 能看到 seed 客户，只有挂到该 SALES 成员才成立；
 *  - 演示 Owner（`SEED_OWNER_SUBJECT`，dataScope=ALL）照样看到全量。
 *
 * 两个 subject 与本地 dev 令牌对应：
 *   Authorization: Bearer dev:demo:demo         → Owner（ALL）
 *   Authorization: Bearer dev:demo-sales:demo   → Sales（OWN）
 * 生产演示请用 Casdoor 同 subject 建号，或在 seed 时用环境变量覆盖。
 */
import { DEFAULT_TENANT_ID, memberships } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type { DataScope, MemberRole } from "@weave-order/schema";
import { and, eq } from "drizzle-orm";
import type { KernelContext } from "../src/kernel";

export interface DemoIdentity {
  tenantId: string;
  /** 演示 Owner 成员 id（memberships.id，不是 Casdoor sub）。 */
  ownerMembershipId: string;
  /** 演示业务员成员 id；演示数据的默认负责人。 */
  salesMembershipId: string;
}

function envValue(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : fallback;
}

async function ensureMembership(
  db: Db,
  tenantId: string,
  subject: string,
  casdoorOrg: string,
  role: MemberRole,
  dataScope: DataScope,
): Promise<string> {
  const existing = await db
    .select({ id: memberships.id, role: memberships.role, dataScope: memberships.dataScope })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.subject, subject)))
    .limit(1);
  const row = existing[0];
  if (row) {
    if (row.role !== role || row.dataScope !== dataScope) {
      console.warn(
        `  ⚠ 成员 ${subject} 已存在但角色/范围不同（${row.role}/${row.dataScope}，期望 ${role}/${dataScope}），沿用现有记录`,
      );
    }
    return row.id;
  }

  const inserted = await db
    .insert(memberships)
    .values({ tenantId, subject, casdoorOrg, role, dataScope })
    .returning({ id: memberships.id });
  const created = inserted[0];
  if (!created) throw new Error(`成员写入未返回记录：${subject}`);
  return created.id;
}

/** 幂等确保演示租户里的 Owner / Sales 成员存在，返回其 membership.id。 */
export async function ensureDemoIdentity(db: Db): Promise<DemoIdentity> {
  const tenantId = envValue("SEED_TENANT_ID", DEFAULT_TENANT_ID);
  const casdoorOrg = envValue("SEED_ORG", "demo");
  const ownerSubject = envValue("SEED_OWNER_SUBJECT", "demo");
  const salesSubject = envValue("SEED_SALES_SUBJECT", "demo-sales");

  const ownerMembershipId = await ensureMembership(
    db,
    tenantId,
    ownerSubject,
    casdoorOrg,
    "OWNER",
    "ALL",
  );
  const salesMembershipId = await ensureMembership(
    db,
    tenantId,
    salesSubject,
    casdoorOrg,
    "SALES",
    "OWN",
  );
  return { tenantId, ownerMembershipId, salesMembershipId };
}

/**
 * seed / demo 的 HUMAN 写入上下文：归属演示业务员。
 * 不设 `dataScope`（写脚本内部读路径不受限），只用于落 `owner_id`。
 */
export function demoWriteContext(identity: DemoIdentity, actorId: string): KernelContext {
  return {
    actor: { type: "HUMAN", id: actorId },
    tenantId: identity.tenantId,
    ownerId: identity.salesMembershipId,
  };
}
