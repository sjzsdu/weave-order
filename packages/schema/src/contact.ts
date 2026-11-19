import { z } from "zod";
import { EntityId, Timestamp } from "./domain";
import { normalizeFieldValue } from "./field-options";

/**
 * 客户联系人契约（WAN-177 / ADR §2）。
 *
 * 一家客户 N 个联系人，数据库只兜底「至多一位有效主要联系人」；
 * 「至少一位」由应用层事务保证（归档主联系人必须先选继任者）。
 * 手机 / 邮箱的掩码规则也放在这里：前后端与智能体读同一份纯函数，
 * 不允许各端各写一套 `138****8000`。
 */

export const CONTACT_PHONE_MAX = 64;
export const CONTACT_NAME_MAX = 255;

/** 角色预置建议：只做建议，存原文；默认收件人规则只认这三个 normalized 值。 */
export const CONTACT_ROLE_PRESETS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "PURCHASING", label: "采购" },
  { code: "FINANCE", label: "财务" },
  { code: "FOLLOW_UP", label: "跟单" },
];

/** 外发场景 → 默认收件人角色（找不到回退主联系人）。 */
export const ContactPurpose = z.enum(["quote", "sample_followup", "statement", "shipment"]);
export type ContactPurpose = z.infer<typeof ContactPurpose>;

const PURPOSE_ROLE: Record<ContactPurpose, string> = {
  quote: "采购",
  // 催样与报价同一类商务往来：采购对接的是价格与交期。
  sample_followup: "采购",
  statement: "财务",
  shipment: "跟单",
};

/**
 * 手机归一化：保留数字与前导 `+`，去掉空格 / 连字符 / 括号。
 *
 * 只用于同客户去重与尾号校验，不替换展示值；无法归一化成有效号码时返回 null，
 * 让「没填手机」与「填了但不成号」在唯一索引里都表现为 NULL（不参与去重）。
 */
export function normalizePhone(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 5) return null;
  return hasPlus ? `+${digits}` : digits;
}

/** `13800138000` → `138****8000`；过短或空值时原样返回（不制造看似完整的假号码）。 */
export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7) return value;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** `zhou@qinghe.com` → `z***@qinghe.com`；保留域名，方便确认发给哪家公司。 */
export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

/** 内网仍是纯数据对象：掩码与否由读模型决定，契约字段类型不变。 */
export const CustomerContact = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    customerId: EntityId,
    name: z.string().min(1).max(CONTACT_NAME_MAX),
    /** 原文；走 `field_options(contact.role)` 只做建议，不建外键。 */
    role: z.string().max(64).nullable(),
    /** VIEWER 看到的是掩码值，其余角色看到原文。 */
    phone: z.string().max(CONTACT_PHONE_MAX).nullable(),
    email: z.string().max(255).nullable(),
    wechat: z.string().max(128).nullable(),
    note: z.string().max(2000).nullable(),
    isPrimary: z.boolean(),
    archivedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type CustomerContact = z.infer<typeof CustomerContact>;

const ContactBase = {
  name: z.string().trim().min(1).max(CONTACT_NAME_MAX),
  role: z.string().trim().max(64).nullable().optional(),
  phone: z.string().trim().max(CONTACT_PHONE_MAX).nullable().optional(),
  email: z.string().trim().email().max(255).nullable().optional(),
  wechat: z.string().trim().max(128).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
};

export const CreateCustomerContactInput = z
  .object({
    ...ContactBase,
    /** 首位联系人自动成为主要联系人；显式传 true 会换主（同事务清掉旧主要）。 */
    isPrimary: z.boolean().optional(),
  })
  .strict();
export type CreateCustomerContactInput = z.infer<typeof CreateCustomerContactInput>;

export const UpdateCustomerContactInput = z
  .object({
    ...ContactBase,
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "至少需要更新一个字段" });
export type UpdateCustomerContactInput = z.infer<typeof UpdateCustomerContactInput>;

export const ArchiveCustomerContactInput = z
  .object({
    /** 归档主联系人时必填：同一事务里先换主再归档，保证「至少一位」不断档。 */
    successorContactId: EntityId.optional(),
  })
  .strict();
export type ArchiveCustomerContactInput = z.infer<typeof ArchiveCustomerContactInput>;

/**
 * 跨客户同号只提示不阻断：风险是两家客户共用一个采购，不是录入错误，
 * 阻断会逼着用户把号码改成假的。同客户重复仍由唯一索引硬拦。
 */
export const ContactWarning = z
  .object({
    code: z.literal("PHONE_SHARED_ACROSS_CUSTOMERS"),
    message: z.string(),
    customerId: EntityId,
    customerName: z.string(),
  })
  .strict();
export type ContactWarning = z.infer<typeof ContactWarning>;

export const ContactMutationResult = z
  .object({
    contact: CustomerContact,
    warnings: z.array(ContactWarning),
  })
  .strict();
export type ContactMutationResult = z.infer<typeof ContactMutationResult>;

export const CustomerContactsResponse = z
  .object({
    contacts: z.array(CustomerContact),
  })
  .strict();
export type CustomerContactsResponse = z.infer<typeof CustomerContactsResponse>;

/** 联系人角色建议（来自 `field_options(contact.role)`，按 sortOrder 排序）。 */
export const ContactRoleOption = z
  .object({
    code: z.string().min(1).max(64),
    label: z.string().min(1).max(128),
  })
  .strict();
export type ContactRoleOption = z.infer<typeof ContactRoleOption>;

export const ContactRoleOptionsResponse = z
  .object({ roles: z.array(ContactRoleOption) })
  .strict();
export type ContactRoleOptionsResponse = z.infer<typeof ContactRoleOptionsResponse>;

/**
 * 默认收件人：先按场景找角色（采购 / 财务 / 跟单），找不到回退主联系人，
 * 再回退最早创建的未归档联系人。已被归档的联系人不参与。
 */
export function pickDefaultContact<T extends { role: string | null; isPrimary: boolean }>(
  contacts: readonly T[],
  purpose: ContactPurpose,
): T | null {
  if (contacts.length === 0) return null;
  const wanted = normalizeFieldValue(PURPOSE_ROLE[purpose]);
  const byRole = contacts.find(
    (contact) => contact.role !== null && normalizeFieldValue(contact.role) === wanted,
  );
  if (byRole) return byRole;
  return contacts.find((contact) => contact.isPrimary) ?? contacts[0] ?? null;
}

/** 批量导出结果：CSV 文本 + 行数 + 是否对当前查看者掩码。 */
export const ContactExportResult = z
  .object({
    csv: z.string(),
    rowCount: z.number().int().nonnegative(),
    masked: z.boolean(),
  })
  .strict();
export type ContactExportResult = z.infer<typeof ContactExportResult>;
