/**
 * 演示 / seed 数据的身份目录（WAN-106、WAN-136）。
 *
 * 背景：
 *  - `dataScope` 默认 `OWN`，而 `customers.owner_id` 可空。如果 seed / demo 写入
 *    不带 `ownerId`，数据就挂成 NULL，`OWN` 成员永远看不到，演示环境登录后客户
 *    列表是空的。所以演示数据统一挂到「演示业务员」成员（`demo-sales`）。
 *  - WAN-136 起，演示身份不再只有 Owner / Sales 两个，而是
 *    `packages/schema/src/personas.ts` 里的全部 7 个角色。seed、dev 切换端点、
 *    前端身份条、e2e fixture 共用同一份目录，避免出现「界面上有财务、库里没有」。
 *
 * 经理（MANAGER + TEAM）与业务员（SALES + OWN）必须落在同一个 teamId，
 * 否则 TEAM 范围退化成「本人」，经理切过去看到的是一条空列表。
 *
 * 幂等：同一 tenant+subject 只保留一行；角色/范围/团队与目录不一致时以目录为准，
 * 这样老开发库升级后也能立刻得到正确的 7 个角色。
 */
import { DEFAULT_TENANT_ID, memberships } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { PERSONAS } from "@weave-order/schema";
import type { Persona, PersonaKey } from "@weave-order/schema";
import { and, eq } from "drizzle-orm";
import type { KernelContext } from "./audit";

export interface DemoIdentity {
  tenantId: string;
  /** 演示 Owner 成员 id（memberships.id，不是 Casdoor sub）。 */
  ownerMembershipId: string;
  /** 演示业务员成员 id；演示数据的默认负责人。 */
  salesMembershipId: string;
  /** 7 个 persona 对应的成员 id，按 personaKey 索引。 */
  personaMembershipIds: Record<PersonaKey, string>;
}

function envValue(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : fallback;
}

async function ensureMembership(db: Db, tenantId: string, persona: Persona): Promise<string> {
  const casdoorOrg = envValue("SEED_ORG", "demo");
  const existing = await db
    .select({
      id: memberships.id,
      role: memberships.role,
      dataScope: memberships.dataScope,
      teamId: memberships.teamId,
      status: memberships.status,
    })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.subject, persona.subject)))
    .limit(1);
  const row = existing[0];
  if (row) {
    const drifted =
      row.role !== persona.role ||
      row.dataScope !== persona.dataScope ||
      row.teamId !== persona.teamId ||
      row.status !== "ACTIVE";
    if (drifted) {
      await db
        .update(memberships)
        .set({
          role: persona.role,
          dataScope: persona.dataScope,
          teamId: persona.teamId,
          status: "ACTIVE",
          updatedAt: new Date(),
        })
        .where(eq(memberships.id, row.id));
      console.warn(
        `  ⚠ 成员 ${persona.subject} 与 persona 目录不一致（原 ${row.role}/${row.dataScope}/${row.teamId ?? "-"}/${row.status}），已按目录校正`,
      );
    }
    return row.id;
  }

  const inserted = await db
    .insert(memberships)
    .values({
      tenantId,
      subject: persona.subject,
      casdoorOrg,
      role: persona.role,
      dataScope: persona.dataScope,
      teamId: persona.teamId,
      status: "ACTIVE",
    })
    .returning({ id: memberships.id });
  const created = inserted[0];
  if (!created) throw new Error(`成员写入未返回记录：${persona.subject}`);
  return created.id;
}

/** 幂等确保演示租户里 7 个 persona 成员都存在，返回其 membership.id。 */
export async function ensureDemoIdentity(db: Db): Promise<DemoIdentity> {
  const tenantId = envValue("SEED_TENANT_ID", DEFAULT_TENANT_ID);

  const personaMembershipIds = {} as Record<PersonaKey, string>;
  for (const persona of PERSONAS) {
    personaMembershipIds[persona.key] = await ensureMembership(db, tenantId, persona);
  }

  const ownerMembershipId = personaMembershipIds.owner;
  const salesMembershipId = personaMembershipIds.sales;
  if (!ownerMembershipId || !salesMembershipId) {
    throw new Error("persona 目录缺少 owner/sales，无法建立演示身份");
  }
  return { tenantId, ownerMembershipId, salesMembershipId, personaMembershipIds };
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
