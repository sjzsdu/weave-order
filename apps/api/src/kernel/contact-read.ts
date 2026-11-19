import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { customerContacts } from "@weave-order/db";
import type { CustomerContactRow, Db } from "@weave-order/db";
import { CustomerContact, hasCapability, maskEmail, maskPhone } from "@weave-order/schema";
import type { MemberRole } from "@weave-order/schema";
import { toIso } from "./mappers";

/**
 * 联系人读模型（列表 / 客户 360 / 外发 / 分享面板共用）。
 *
 * 所有返回明文的地方都必须经过 `toContact`：PII 裁剪只发生在读模型层，
 * 后端不把明文发给没有 `contact.pii.view` 的 VIEWER，而不是让前端挡一下。
 * 无角色（系统任务 / 智能体内核）视为全量，与成本字段的口径一致。
 */
export function mayViewContactPii(role?: MemberRole): boolean {
  if (!role) return true;
  return hasCapability(role, "contact.pii.view");
}

export function toContact(row: CustomerContactRow, role?: MemberRole): CustomerContact {
  const masked = !mayViewContactPii(role);
  return CustomerContact.parse({
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId,
    name: row.name,
    role: row.role,
    phone: masked ? maskPhone(row.phone) : row.phone,
    email: masked ? maskEmail(row.email) : row.email,
    wechat: row.wechat,
    note: row.note,
    isPrimary: row.isPrimary,
    archivedAt: row.archivedAt ? toIso(row.archivedAt) : null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  });
}

/** 某客户的全部未归档联系人；主要联系人在前，其余按创建时间正序。 */
export async function loadActiveContacts(
  db: Db,
  tenantId: string,
  customerId: string,
  role?: MemberRole,
): Promise<CustomerContact[]> {
  const rows = await db
    .select()
    .from(customerContacts)
    .where(
      and(
        eq(customerContacts.tenantId, tenantId),
        eq(customerContacts.customerId, customerId),
        isNull(customerContacts.archivedAt),
      ),
    )
    .orderBy(desc(customerContacts.isPrimary), asc(customerContacts.createdAt));
  return rows.map((row) => toContact(row, role));
}

/**
 * 批量取「主联系人投影」：列表 / 客户 360 一次查完，避免 N+1。
 *
 * 回退规则与 ADR 一致：先取 is_primary，缺失时取最近创建的未归档联系人；
 * 只回退不写回，所以历史数据缺主联系人不会在读取时被悄悄改账。
 * 返回原始行（非掩码）供调用方按查看者能力组装读模型。
 */
export async function loadPrimaryContactRows(
  db: Db,
  tenantId: string,
  customerIds: readonly string[],
): Promise<Map<string, CustomerContactRow>> {
  const result = new Map<string, CustomerContactRow>();
  if (customerIds.length === 0) return result;
  const rows = await db
    .select()
    .from(customerContacts)
    .where(
      and(
        eq(customerContacts.tenantId, tenantId),
        inArray(customerContacts.customerId, [...customerIds]),
        isNull(customerContacts.archivedAt),
      ),
    )
    .orderBy(desc(customerContacts.isPrimary), desc(customerContacts.createdAt));
  for (const row of rows) {
    // 已按「主 → 最近创建」排序，第一次出现即该客户的有效收件人。
    if (!result.has(row.customerId)) result.set(row.customerId, row);
  }
  return result;
}

/** 单个客户的投影行（客户 360 / getById 用）。 */
export async function loadPrimaryContactRow(
  db: Db,
  tenantId: string,
  customerId: string,
): Promise<CustomerContactRow | null> {
  const rows = await loadPrimaryContactRows(db, tenantId, [customerId]);
  return rows.get(customerId) ?? null;
}
