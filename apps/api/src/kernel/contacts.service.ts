import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { customerContacts, customers, fieldOptions } from "@weave-order/db";
import type { CustomerContactRow, Db, Tx } from "@weave-order/db";
import {
  ArchiveCustomerContactInput,
  CONTACT_ROLE_PRESETS,
  ContactRoleOptionsResponse,
  ContactMutationResult,
  CreateCustomerContactInput,
  maskEmail,
  maskPhone,
  normalizePhone,
  pickDefaultContact,
  UpdateCustomerContactInput,
} from "@weave-order/schema";
import type { ContactPurpose, ContactWarning } from "@weave-order/schema";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { loadActiveContacts, mayViewContactPii, toContact } from "./contact-read";
import { ownerScopeFilter } from "./data-scope";
import { KernelError, isUniqueViolation, uniqueViolationConstraint } from "./errors";
import { toIso } from "./mappers";
import type { CustomerService } from "./customers.service";

type ContactRow = CustomerContactRow;

/** 唯一索引 → 可判别错误码；同客户重复阻断，跨客户重复只提示。 */
function contactConstraintError(error: unknown): unknown {
  if (!isUniqueViolation(error)) return error;
  switch (uniqueViolationConstraint(error)) {
    case "customer_contacts_primary_idx":
      return new KernelError("KERNEL_REJECTED", "该客户已有主要联系人，请先换主再设置", {
        reason: "CONTACT_PRIMARY_CONFLICT",
      });
    case "customer_contacts_phone_idx":
      return new KernelError("KERNEL_REJECTED", "同一客户下这个手机号已存在", {
        reason: "CONTACT_PHONE_DUPLICATE",
      });
    case "customer_contacts_email_idx":
      return new KernelError("KERNEL_REJECTED", "同一客户下这个邮箱已存在", {
        reason: "CONTACT_EMAIL_DUPLICATE",
      });
    default:
      return error;
  }
}

function nullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function emptyToUndefined(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return nullable(value);
}

/**
 * 客户联系人内核服务（WAN-177 / ADR §2）。
 *
 * 唯一写入 `customer_contacts` 的入口，三条不变量都落在这里：
 * 1. 至多一位有效主联系人：换主 = 同事务清旧主；数据库部分唯一索引兜底。
 * 2. 至少一位：归档主联系人必须选继任者，且继任者先成为主联系人。
 * 3. 旧三列只是投影：每次联系人写入后同事务同步 `customers.contact_*`。
 */
export class ContactService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly customerService: CustomerService,
  ) {}

  async list(customerId: string, ctx: KernelContext) {
    // 越权客户按「不存在」处理，不泄露联系人。
    await this.customerService.getById(customerId, ctx);
    return loadActiveContacts(this.db, this.tenantId, customerId, ctx.actor.role);
  }

  /** 角色建议来自 `field_options(contact.role)`；新租户尚未播种时回退预置三项。 */
  async roleOptions(): Promise<ContactRoleOptionsResponse> {
    const rows = await this.db
      .select({ code: fieldOptions.code, label: fieldOptions.label })
      .from(fieldOptions)
      .where(
        and(
          eq(fieldOptions.tenantId, this.tenantId),
          eq(fieldOptions.fieldKey, "contact.role"),
          eq(fieldOptions.active, true),
        ),
      )
      .orderBy(asc(fieldOptions.sortOrder), asc(fieldOptions.label));
    const roles = rows.length > 0 ? rows : CONTACT_ROLE_PRESETS.map((item) => ({ ...item }));
    return ContactRoleOptionsResponse.parse({ roles });
  }

  async create(customerId: string, input: unknown, ctx: KernelContext) {
    this.requireEditPermission(ctx);
    const parsed = CreateCustomerContactInput.parse(input);
    await this.customerService.getById(customerId, ctx);
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockCustomer(tx, customerId);
        const existing = await this.activeRows(tx, customerId);
        // 第一位联系人自动成为主要联系人；显式 isPrimary=true 会换主。
        const makePrimary = existing.length === 0 || parsed.isPrimary === true;
        if (makePrimary) await this.clearPrimary(tx, customerId);
        const rows = await tx
          .insert(customerContacts)
          .values({
            tenantId: this.tenantId,
            customerId,
            name: parsed.name,
            role: emptyToUndefined(parsed.role) ?? null,
            phone: emptyToUndefined(parsed.phone) ?? null,
            phoneNormalized: normalizePhone(parsed.phone),
            email: emptyToUndefined(parsed.email) ?? null,
            wechat: emptyToUndefined(parsed.wechat) ?? null,
            note: emptyToUndefined(parsed.note) ?? null,
            isPrimary: makePrimary,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new KernelError("KERNEL_REJECTED", "联系人写入未返回记录", {
            reason: "INSERT_RETURNED_NO_ROW",
          });
        }
        await this.syncProjection(tx, customerId);
        await appendAudit(
          tx,
          ctx,
          {
            action: "CONTACT_CREATED",
            entityType: "customer_contact",
            entityId: row.id,
            before: null,
            after: {
              customerId,
              name: row.name,
              role: row.role,
              isPrimary: row.isPrimary,
            },
            entityLabel: row.name,
          },
          this.tenantId,
        );
        const warnings = await this.crossCustomerPhoneWarnings(tx, customerId, row, ctx);
        return ContactMutationResult.parse({
          contact: toContact(row, ctx.actor.role),
          warnings,
        });
      });
    } catch (error) {
      throw contactConstraintError(error);
    }
  }

  async update(contactId: string, input: unknown, ctx: KernelContext) {
    this.requireEditPermission(ctx);
    const parsed = UpdateCustomerContactInput.parse(input);
    const current = await this.requireContact(contactId, ctx);
    const customerId = current.customerId;
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockCustomer(tx, customerId);
        const before = await this.requireRow(tx, contactId);
        if (before.archivedAt) {
          throw new KernelError("KERNEL_REJECTED", "已归档的联系人不能修改", {
            reason: "CONTACT_ARCHIVED",
          });
        }
        const nextPrimary =
          parsed.isPrimary === undefined ? before.isPrimary : parsed.isPrimary;
        // 「至少一位」不能靠把唯一主联系人降级实现；先指定别的联系人为主。
        if (before.isPrimary && parsed.isPrimary === false) {
          throw new KernelError("KERNEL_REJECTED", "客户必须保留一位主要联系人，请先指定其他联系人", {
            reason: "CONTACT_PRIMARY_REQUIRED",
          });
        }
        if (nextPrimary && !before.isPrimary) await this.clearPrimary(tx, customerId);
        const rows = await tx
          .update(customerContacts)
          .set({
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.role !== undefined ? { role: emptyToUndefined(parsed.role) ?? null } : {}),
            ...(parsed.phone !== undefined
              ? {
                  phone: emptyToUndefined(parsed.phone) ?? null,
                  phoneNormalized: normalizePhone(parsed.phone),
                }
              : {}),
            ...(parsed.email !== undefined
              ? { email: emptyToUndefined(parsed.email) ?? null }
              : {}),
            ...(parsed.wechat !== undefined
              ? { wechat: emptyToUndefined(parsed.wechat) ?? null }
              : {}),
            ...(parsed.note !== undefined ? { note: emptyToUndefined(parsed.note) ?? null } : {}),
            isPrimary: nextPrimary,
            updatedAt: new Date(),
          })
          .where(and(eq(customerContacts.id, contactId), eq(customerContacts.tenantId, this.tenantId)))
          .returning();
        const row = rows[0];
        if (!row) {
          throw new KernelError("RESOURCE_NOT_FOUND", "联系人不存在", {
            resourceType: "customer_contact",
            resourceId: contactId,
          });
        }
        await this.syncProjection(tx, customerId);
        await appendAudit(
          tx,
          ctx,
          {
            action: "CONTACT_UPDATED",
            entityType: "customer_contact",
            entityId: row.id,
            before: {
              name: before.name,
              role: before.role,
              phone: before.phone,
              email: before.email,
              wechat: before.wechat,
              note: before.note,
              isPrimary: before.isPrimary,
            },
            after: {
              customerId,
              name: row.name,
              role: row.role,
              phone: row.phone,
              email: row.email,
              wechat: row.wechat,
              note: row.note,
              isPrimary: row.isPrimary,
            },
            entityLabel: row.name,
          },
          this.tenantId,
        );
        if (!before.isPrimary && row.isPrimary) {
          await appendAudit(
            tx,
            ctx,
            {
              action: "CONTACT_PRIMARY_CHANGED",
              entityType: "customer_contact",
              entityId: row.id,
              before: { primaryContactId: before.id, isPrimary: false },
              after: { primaryContactId: row.id, isPrimary: true },
              entityLabel: row.name,
            },
            this.tenantId,
          );
        }
        const warnings = await this.crossCustomerPhoneWarnings(tx, customerId, row, ctx);
        return ContactMutationResult.parse({
          contact: toContact(row, ctx.actor.role),
          warnings,
        });
      });
    } catch (error) {
      throw contactConstraintError(error);
    }
  }

  async setPrimary(contactId: string, ctx: KernelContext) {
    this.requireEditPermission(ctx);
    const current = await this.requireContact(contactId, ctx);
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockCustomer(tx, current.customerId);
        const before = await this.requireRow(tx, contactId);
        if (before.archivedAt) {
          throw new KernelError("KERNEL_REJECTED", "已归档的联系人不能设为主联系人", {
            reason: "CONTACT_ARCHIVED",
          });
        }
        if (before.isPrimary) {
          return ContactMutationResult.parse({
            contact: toContact(before, ctx.actor.role),
            warnings: [],
          });
        }
        await this.clearPrimary(tx, current.customerId);
        const rows = await tx
          .update(customerContacts)
          .set({ isPrimary: true, updatedAt: new Date() })
          .where(eq(customerContacts.id, contactId))
          .returning();
        const row = rows[0];
        if (!row) throw this.notFound(contactId);
        await this.syncProjection(tx, current.customerId);
        await appendAudit(
          tx,
          ctx,
          {
            action: "CONTACT_PRIMARY_CHANGED",
            entityType: "customer_contact",
            entityId: row.id,
            before: { primaryContactId: before.isPrimary ? before.id : null },
            after: { primaryContactId: row.id, customerId: current.customerId },
            entityLabel: row.name,
          },
          this.tenantId,
        );
        return ContactMutationResult.parse({
          contact: toContact(row, ctx.actor.role),
          warnings: [],
        });
      });
    } catch (error) {
      throw contactConstraintError(error);
    }
  }

  /**
   * 归档（不物理删除）。归档主联系人必须给继任者，且继任者先成为主联系人，
   * 两步在同一事务里完成，中途失败不会留下「没有主联系人」的状态。
   */
  async archive(contactId: string, input: unknown, ctx: KernelContext) {
    this.requireEditPermission(ctx);
    const parsed = ArchiveCustomerContactInput.parse(input ?? {});
    const current = await this.requireContact(contactId, ctx);
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockCustomer(tx, current.customerId);
        const before = await this.requireRow(tx, contactId);
        if (before.archivedAt) {
          // 幂等：重复归档直接返回当前状态，不重复写审计。
          return ContactMutationResult.parse({
            contact: toContact(before, ctx.actor.role),
            warnings: [],
          });
        }
        let successor: ContactRow | null = null;
        if (before.isPrimary) {
          if (!parsed.successorContactId) {
            throw new KernelError("KERNEL_REJECTED", "归档主要联系人前请先指定继任者", {
              reason: "CONTACT_SUCCESSOR_REQUIRED",
            });
          }
          if (parsed.successorContactId === contactId) {
            throw new KernelError("KERNEL_REJECTED", "继任者不能是正在归档的联系人", {
              reason: "CONTACT_SUCCESSOR_INVALID",
            });
          }
          const candidates = await this.activeRows(tx, current.customerId);
          successor =
            candidates.find((row) => row.id === parsed.successorContactId) ?? null;
          if (!successor) {
            throw new KernelError("KERNEL_REJECTED", "继任者不存在或已归档", {
              reason: "CONTACT_SUCCESSOR_NOT_FOUND",
            });
          }
          await this.clearPrimary(tx, current.customerId);
          const promoted = await tx
            .update(customerContacts)
            .set({ isPrimary: true, updatedAt: new Date() })
            .where(eq(customerContacts.id, successor.id))
            .returning();
          successor = promoted[0] ?? successor;
        }
        const rows = await tx
          .update(customerContacts)
          .set({ archivedAt: new Date(), isPrimary: false, updatedAt: new Date() })
          .where(eq(customerContacts.id, contactId))
          .returning();
        const row = rows[0];
        if (!row) throw this.notFound(contactId);
        await this.syncProjection(tx, current.customerId);
        await appendAudit(
          tx,
          ctx,
          {
            action: "CONTACT_ARCHIVED",
            entityType: "customer_contact",
            entityId: row.id,
            before: { name: before.name, isPrimary: before.isPrimary, archivedAt: null },
            after: {
              customerId: current.customerId,
              name: row.name,
              archivedAt: toIso(row.archivedAt ?? new Date()),
              successorContactId: successor?.id ?? null,
            },
            entityLabel: row.name,
          },
          this.tenantId,
        );
        if (successor) {
          await appendAudit(
            tx,
            ctx,
            {
              action: "CONTACT_PRIMARY_CHANGED",
              entityType: "customer_contact",
              entityId: successor.id,
              before: { primaryContactId: before.id },
              after: { primaryContactId: successor.id, customerId: current.customerId },
              entityLabel: successor.name,
            },
            this.tenantId,
          );
        }
        return ContactMutationResult.parse({
          contact: toContact(row, ctx.actor.role),
          warnings: [],
        });
      });
    } catch (error) {
      throw contactConstraintError(error);
    }
  }

  /**
   * 批量导出联系人：只导出查看者数据范围内的客户，VIEWER 的手机/邮箱仍掩码；
   * 导出动作本身写一条 `AUDIT_EXPORTED`（时间范围、行数、是否掩码），不逐行递归。
   */
  async exportCsv(ctx: KernelContext): Promise<{ csv: string; rowCount: number; masked: boolean }> {
    const conditions = [sql`customers.tenant_id = ${this.tenantId}`];
    // 不使用表别名：`ownerScopeFilter` 生成的条件直接引用 `customers.owner_id`。
    const scope = ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId);
    if (scope) conditions.push(scope);
    const result = await this.db.execute<{
      [key: string]: unknown;
      customer_code: string;
      customer_name: string;
      name: string;
      role: string | null;
      phone: string | null;
      email: string | null;
      wechat: string | null;
      is_primary: boolean;
      note: string | null;
    }>(sql`
      SELECT customers.code AS customer_code,
             customers.name AS customer_name,
             cc.name,
             cc.role,
             cc.phone,
             cc.email,
             cc.wechat,
             cc.is_primary,
             cc.note
      FROM customer_contacts cc
      JOIN customers ON customers.id = cc.customer_id AND customers.tenant_id = cc.tenant_id
      WHERE cc.tenant_id = ${this.tenantId}
        AND cc.archived_at IS NULL
        AND ${sql.join(conditions, sql` AND `)}
      ORDER BY customers.code ASC, cc.is_primary DESC, cc.created_at ASC
    `);
    const masked = !mayViewContactPii(ctx.actor.role);
    const header = ["客户编号", "客户名称", "姓名", "角色", "手机", "邮箱", "微信", "主要", "备注"];
    const lines = result.rows.map((row) => {
      const contact = {
        phone: row.phone,
        email: row.email,
      };
      const maskedContact = masked
        ? { phone: maskPhone(row.phone), email: maskEmail(row.email) }
        : contact;
      return [
        row.customer_code,
        row.customer_name,
        row.name,
        row.role ?? "",
        maskedContact.phone ?? "",
        maskedContact.email ?? "",
        row.wechat ?? "",
        row.is_primary ? "是" : "否",
        row.note ?? "",
      ]
        .map(csvCell)
        .join(",");
    });
    const csv = [header.map(csvCell).join(","), ...lines].join("\n");
    await this.db.transaction(async (tx) => {
      await appendAudit(
        tx,
        ctx,
        {
          action: "AUDIT_EXPORTED",
          entityType: "customer_contact",
          entityId: this.tenantId,
          before: null,
          after: {
            scope: "customer_contacts",
            rowCount: lines.length,
            masked,
            exportedAt: new Date().toISOString(),
          },
          entityLabel: "客户联系人导出",
        },
        this.tenantId,
      );
    });
    return { csv, rowCount: lines.length, masked };
  }

  /** 修正待办 / 外发默认收件人：按场景挑角色，找不到回退主联系人。 */
  async suggestedRecipient(
    customerId: string,
    purpose: ContactPurpose,
    ctx: KernelContext,
  ): Promise<string | null> {
    const contacts = await loadActiveContacts(this.db, this.tenantId, customerId, ctx.actor.role);
    return pickDefaultContact(contacts, purpose)?.id ?? null;
  }

  // ---- 内部 ----

  /**
   * VIEWER 是只读席位：手机/邮箱被掩码，写回会把 `138****8000` 当真实值存进去。
   * 因此写路径同样要求 `contact.pii.view`，前端也按同一能力隐藏编辑入口。
   */
  private requireEditPermission(ctx: KernelContext): void {
    if (!mayViewContactPii(ctx.actor.role)) {
      throw new KernelError("PERMISSION_DENIED", "只读席位不能修改联系人", {
        reason: "CONTACT_PII_MASKED",
      });
    }
  }

  private notFound(contactId: string): KernelError {
    return new KernelError("RESOURCE_NOT_FOUND", "联系人不存在", {
      resourceType: "customer_contact",
      resourceId: contactId,
    });
  }

  /** 行锁客户：同一客户的换主 / 归档串行执行，避免并发写出两位主联系人。 */
  private async lockCustomer(tx: Tx, customerId: string): Promise<void> {
    await tx.execute(
      sql`SELECT id FROM customers WHERE id = ${customerId}::uuid AND tenant_id = ${this.tenantId}::uuid FOR UPDATE`,
    );
  }

  private async activeRows(tx: Tx | Db, customerId: string): Promise<ContactRow[]> {
    return tx
      .select()
      .from(customerContacts)
      .where(
        and(
          eq(customerContacts.tenantId, this.tenantId),
          eq(customerContacts.customerId, customerId),
          isNull(customerContacts.archivedAt),
        ),
      )
      .orderBy(asc(customerContacts.createdAt));
  }

  private async clearPrimary(tx: Tx, customerId: string): Promise<void> {
    await tx
      .update(customerContacts)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(customerContacts.tenantId, this.tenantId),
          eq(customerContacts.customerId, customerId),
          eq(customerContacts.isPrimary, true),
        ),
      );
  }

  /** 旧三列 = 主联系人投影；联系人任何写入后同事务刷新，绝不允许两处漂移。 */
  private async syncProjection(tx: Tx, customerId: string): Promise<void> {
    const rows = await tx
      .select()
      .from(customerContacts)
      .where(
        and(
          eq(customerContacts.tenantId, this.tenantId),
          eq(customerContacts.customerId, customerId),
          isNull(customerContacts.archivedAt),
        ),
      )
      .orderBy(sql`${customerContacts.isPrimary} DESC`, sql`${customerContacts.createdAt} DESC`)
      .limit(1);
    const primary = rows[0] ?? null;
    await tx
      .update(customers)
      .set({
        contactName: primary?.name ?? null,
        contactPhone: primary?.phone ?? null,
        contactEmail: primary?.email ?? null,
      })
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, this.tenantId)));
  }

  private async requireRow(tx: Tx | Db, contactId: string): Promise<ContactRow> {
    const rows = await tx
      .select()
      .from(customerContacts)
      .where(and(eq(customerContacts.id, contactId), eq(customerContacts.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw this.notFound(contactId);
    return row;
  }

  /** 读取联系人并校验客户对当前查看者可见（越权按「不存在」处理）。 */
  private async requireContact(contactId: string, ctx: KernelContext): Promise<ContactRow> {
    const row = await this.requireRow(this.db, contactId);
    await this.customerService.getById(row.customerId, ctx);
    return row;
  }

  /**
   * 跨客户同号只提示不阻断：返回数据范围内其他客户的名称，
   * 避免把别人的客户名泄露给只有 OWN 范围的人。
   */
  private async crossCustomerPhoneWarnings(
    tx: Tx,
    customerId: string,
    row: ContactRow,
    ctx: KernelContext,
  ): Promise<ContactWarning[]> {
    if (!row.phoneNormalized) return [];
    const conditions = [
      sql`cc.tenant_id = ${this.tenantId}`,
      sql`cc.phone_normalized = ${row.phoneNormalized}`,
      sql`cc.archived_at IS NULL`,
      sql`cc.customer_id <> ${customerId}::uuid`,
    ];
    const scope = ownerScopeFilter(tx, ctx, this.tenantId, customers.ownerId);
    if (scope) conditions.push(scope);
    const result = await tx.execute<{ customer_id: string; customer_name: string }>(sql`
      SELECT DISTINCT c.id AS customer_id, c.name AS customer_name
      FROM customer_contacts cc
      JOIN customers c ON c.id = cc.customer_id AND c.tenant_id = cc.tenant_id
      WHERE ${sql.join(conditions, sql` AND `)}
      LIMIT 5
    `);
    return result.rows.map((other) => ({
      code: "PHONE_SHARED_ACROSS_CUSTOMERS" as const,
      message: `这个手机号也登记在客户「${other.customer_name}」名下，只提示不影响保存。`,
      customerId: other.customer_id,
      customerName: other.customer_name,
    }));
  }
}

/** CSV 单元格转义：逗号 / 引号 / 换行必须加引号，引号双写。 */
function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
