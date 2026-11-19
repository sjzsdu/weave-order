import { customers } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  CustomerListItem,
  CustomerSummary,
  CustomerTimelineEvent,
  CustomerTimelinePage,
  maskEmail,
  maskPhone,
} from "@weave-order/schema";
import type {
  Currency,
  CustomerListOptions,
  CustomerTimelineKind,
  MemberRole,
} from "@weave-order/schema";
import { hasCapability } from "@weave-order/schema";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { KernelContext } from "./audit";
import { decodeCursor, encodeCursor, invalidCursor } from "./cursor";
import { ownerScopeFilter } from "./data-scope";
import { KernelError } from "./errors";
import { memberDisplayName } from "./member-label";
import { escapeLikePattern } from "./search.service";

/**
 * 客户聚合读（列表 / 汇总 / 时间线）。
 *
 * 为什么集中在一个模块：所有数字的口径必须只写一次。列表、桌面 360、
 * 移动端 360 都调这里的 SQL，才不会出现「列表 3 个在途、详情 5 个」。
 *
 * 为什么用裸 SQL：200 条客户 × 4 类单据的聚合用 drizzle 子查询拼出来
 * 不可读，而且容易漏掉「先按数据范围过滤再分页」的顺序。这里保留一条
 * 明确的 SQL，索引命中（quotes_tenant_customer_idx 等）一眼可查。
 */

interface CustomerListRow {
  [key: string]: unknown;
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  tier: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  owner_id: string | null;
  owner_name: string | null;
  pending_quote_count: number;
  in_transit_sample_count: number;
  active_order_count: number;
  receivable_balance: Array<{ amount: string | number; currency: string }>;
  overdue_receivable_count: number;
  last_contact_at: Date | string | null;
}

interface CustomerSummaryRow {
  [key: string]: unknown;
  pending_quote_count: number;
  in_transit_sample_count: number;
  active_order_count: number;
  receivable_balance: Array<{ amount: string | number; currency: string }>;
  overdue_receivable_count: number;
  latest_shareable_quote_id: string | null;
  last_contact_at: Date | string | null;
}

interface TimelineRow {
  [key: string]: unknown;
  kind: string;
  ref_id: string;
  source_id: string;
  code: string | null;
  status: string;
  amount: string | number | null;
  currency: string | null;
  occurred_at: Date | string;
}

function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function balancesOf(
  rows: Array<{ amount: string | number; currency: string }>,
): Array<{ amount: number; currency: Currency }> {
  return rows.map((row) => ({
    amount: Number(row.amount),
    currency: row.currency as Currency,
  }));
}

/** 组装列表 / 汇总都会用到的聚合列（同一份 SQL 片段）。 */
function aggregateColumns(): SQL {
  return sql`
    (SELECT count(*)::int FROM quotes
      WHERE quotes.tenant_id = customers.tenant_id
        AND quotes.customer_id = customers.id
        AND quotes.status = 'DRAFT') AS pending_quote_count,
    (SELECT count(*)::int FROM sample_shipments
      WHERE sample_shipments.tenant_id = customers.tenant_id
        AND sample_shipments.customer_id = customers.id
        AND sample_shipments.status IN ('CONFIRMED', 'SHIPPED')) AS in_transit_sample_count,
    (SELECT count(*)::int FROM orders
      WHERE orders.tenant_id = customers.tenant_id
        AND orders.customer_id = customers.id
        AND orders.status NOT IN ('DRAFT', 'CANCELLED')) AS active_order_count,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('amount', b.balance, 'currency', b.currency) ORDER BY b.currency)
      FROM (
        SELECT receivables.currency::text AS currency,
               sum(receivables.amount - receivables.paid_amount)::bigint AS balance
        FROM receivables
        WHERE receivables.tenant_id = customers.tenant_id
          AND receivables.customer_id = customers.id
          AND receivables.status IN ('PENDING', 'PARTIAL', 'OVERDUE')
        GROUP BY receivables.currency
      ) AS b
    ), '[]'::jsonb) AS receivable_balance,
    (SELECT count(*)::int FROM receivables
      WHERE receivables.tenant_id = customers.tenant_id
        AND receivables.customer_id = customers.id
        AND receivables.status IN ('PENDING', 'PARTIAL', 'OVERDUE')
        AND receivables.due_date < now()) AS overdue_receivable_count,
    (SELECT quotes.id FROM quotes
      WHERE quotes.tenant_id = customers.tenant_id
        AND quotes.customer_id = customers.id
        AND quotes.status = 'SENT'
      ORDER BY quotes.created_at DESC
      LIMIT 1) AS latest_shareable_quote_id,
    -- 「最近联系」只算真实往来（报价 / 寄样 / 订单）；客户档案被编辑不算联系，
    -- 三者都没有时为 NULL，页面显示「还没有往来记录」而不是假装刚联系过。
    GREATEST(
      (SELECT max(quotes.created_at) FROM quotes
        WHERE quotes.tenant_id = customers.tenant_id AND quotes.customer_id = customers.id),
      (SELECT max(sample_shipments.created_at) FROM sample_shipments
        WHERE sample_shipments.tenant_id = customers.tenant_id
          AND sample_shipments.customer_id = customers.id),
      (SELECT max(orders.created_at) FROM orders
        WHERE orders.tenant_id = customers.tenant_id AND orders.customer_id = customers.id)
    ) AS last_contact_at
  `;
}

function mapListItem(row: CustomerListRow, role?: MemberRole): CustomerListItem {
  // 列表与客户 360 同一套 PII 规则：只有 VIEWER 掩码，其余角色全量。
  const masked = role !== undefined && !hasCapability(role, "contact.pii.view");
  return CustomerListItem.parse({
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    tier: row.tier,
    contactName: row.contact_name,
    contactPhone: masked ? maskPhone(row.contact_phone) : row.contact_phone,
    contactEmail: masked ? maskEmail(row.contact_email) : row.contact_email,
    ownerId: row.owner_id,
    // 兜底第二层：SQL 只取姓名/邮箱副本，这里再挡一次 UUID，任何上游回退到 subject 都不会泄漏。
    ownerName: memberDisplayName(row.owner_name),
    pendingQuoteCount: row.pending_quote_count,
    inTransitSampleCount: row.in_transit_sample_count,
    activeOrderCount: row.active_order_count,
    receivableBalance: balancesOf(row.receivable_balance),
    overdueReceivableCount: row.overdue_receivable_count,
    lastContactAt: isoOf(row.last_contact_at),
  });
}

/**
 * 客户列表：先按数据范围 + 筛选过滤，再排序取一页。
 * 聚合用相关子查询而不是 LEFT JOIN + GROUP BY：一条 `customers` 行只落一次，
 * 不会因为多张单据表相乘把计数放大。
 */
export async function loadCustomerList(
  db: Db,
  tenantId: string,
  options: CustomerListOptions,
  ctx?: KernelContext,
): Promise<CustomerListItem[]> {
  const conditions: SQL[] = [sql`customers.tenant_id = ${tenantId}`];
  const scope = ownerScopeFilter(db, ctx, tenantId, customers.ownerId);
  if (scope) conditions.push(scope);

  // 「我的」只是收窄。没有成员身份（本地演示 / 系统任务）时不额外限制，
  // 真正的越权由上面的 data-scope 拦，不靠这个筛选兜底。
  // TEAM 范围下「我的」= 本组：再按 owner_id=self 收窄会让经理看到空列表，
  // 与「经理能看到业务员的客户」的数据范围语义冲突；ALL 范围仍只保留本人。
  if (options.owner === "mine" && ctx?.ownerId && ctx.dataScope !== "TEAM") {
    conditions.push(sql`customers.owner_id = ${ctx.ownerId}`);
  }
  if (options.tier) conditions.push(sql`customers.tier = ${options.tier}`);
  if (options.query) {
    const pattern = `%${escapeLikePattern(options.query)}%`;
    // 搜索扩展到联系人姓名 / 手机 / 邮箱 / 微信：用 EXISTS 判存在性，
    // 不做 join 聚合，避免一个客户多个联系人多出重复行。
    conditions.push(
      sql`(customers.name ILIKE ${pattern} ESCAPE '\\'
        OR customers.code ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM customer_contacts cc
          WHERE cc.tenant_id = customers.tenant_id
            AND cc.customer_id = customers.id
            AND cc.archived_at IS NULL
            AND (cc.name ILIKE ${pattern} ESCAPE '\\'
                 OR cc.phone ILIKE ${pattern} ESCAPE '\\'
                 OR cc.email ILIKE ${pattern} ESCAPE '\\'
                 OR cc.wechat ILIKE ${pattern} ESCAPE '\\')
        ))`,
    );
  }
  if (options.overdueOnly) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM receivables
      WHERE receivables.tenant_id = customers.tenant_id
        AND receivables.customer_id = customers.id
        AND receivables.status IN ('PENDING', 'PARTIAL', 'OVERDUE')
        AND receivables.due_date < now()
    )`);
  }

  const where = sql.join(conditions, sql` AND `);
  const limit = options.limit ?? 50;
  const result = await db.execute<CustomerListRow>(sql`
    SELECT
      customers.id,
      customers.tenant_id,
      customers.code,
      customers.name,
      customers.tier,
      pc.name AS contact_name,
      pc.phone AS contact_phone,
      pc.email AS contact_email,
      customers.owner_id,
      -- 负责人只取可展示的姓名/邮箱副本，绝不回退到 subject（那是 SSO 主键 UUID，WAN-151）。
      COALESCE(
        NULLIF(BTRIM(memberships.display_name), ''),
        NULLIF(BTRIM(memberships.email), '')
      ) AS owner_name,
      ${aggregateColumns()}
    FROM customers
    -- 主联系人投影：优先 is_primary，缺失时取最近创建的未归档联系人（只读回退）。
    LEFT JOIN LATERAL (
      SELECT cc.name, cc.phone, cc.email
      FROM customer_contacts cc
      WHERE cc.tenant_id = customers.tenant_id
        AND cc.customer_id = customers.id
        AND cc.archived_at IS NULL
      ORDER BY cc.is_primary DESC, cc.created_at DESC
      LIMIT 1
    ) pc ON TRUE
    LEFT JOIN memberships
      ON memberships.id = customers.owner_id
     AND memberships.tenant_id = customers.tenant_id
    WHERE ${where}
    ORDER BY customers.created_at DESC, customers.id DESC
    LIMIT ${limit}
  `);
  return result.rows.map((row) => mapListItem(row, ctx?.actor.role));
}

/**
 * 客户汇总：一次聚合查询，口径与列表完全一致。
 * 不在可见范围 / 不存在一律 CUSTOMER_NOT_FOUND（调用方转 404，不泄露存在性）。
 */
export async function loadCustomerSummary(
  db: Db,
  tenantId: string,
  customerId: string,
  ctx?: KernelContext,
): Promise<CustomerSummary> {
  const conditions: SQL[] = [
    sql`customers.tenant_id = ${tenantId}`,
    sql`customers.id = ${customerId}`,
  ];
  const scope = ownerScopeFilter(db, ctx, tenantId, customers.ownerId);
  if (scope) conditions.push(scope);
  const where = sql.join(conditions, sql` AND `);

  const result = await db.execute<CustomerSummaryRow>(sql`
    SELECT ${aggregateColumns()}
    FROM customers
    WHERE ${where}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) {
    throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${customerId}`, { customerId });
  }
  return CustomerSummary.parse({
    customerId,
    pendingQuoteCount: row.pending_quote_count,
    inTransitSampleCount: row.in_transit_sample_count,
    activeOrderCount: row.active_order_count,
    receivableBalance: balancesOf(row.receivable_balance),
    overdueReceivableCount: row.overdue_receivable_count,
    latestShareableQuoteId: row.latest_shareable_quote_id,
    lastContactAt: isoOf(row.last_contact_at),
  });
}

/**
 * 客户时间线：报价 / 寄样 / 订单 / 回款 / 跟进 五类源单据合并后按时间倒序。
 *
 * 翻页在数据库里完成（keyset on `occurred_at, ref_id`），首屏 20 条，
 * 200 条历史也只读 20 条；不是在应用层合并后再切。
 */
export async function loadCustomerTimeline(
  db: Db,
  tenantId: string,
  customerId: string,
  options: { kinds?: CustomerTimelineKind[]; limit?: number; cursor?: string | null },
): Promise<CustomerTimelinePage> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const cursor = decodeCursor(options.cursor);
  let cursorAt: string | null = null;
  let cursorRef: string | null = null;
  if (cursor) {
    if (typeof cursor.occurredAt !== "string" || Number.isNaN(Date.parse(cursor.occurredAt))) {
      throw invalidCursor();
    }
    if (typeof cursor.refId !== "string" || cursor.refId.length === 0) throw invalidCursor();
    cursorAt = cursor.occurredAt;
    cursorRef = cursor.refId;
  }
  const kinds = options.kinds ?? [];
  // 逐个占位而不是把数组当一个参数：pg 会把数组参数当成行构造器，
  // `= ANY($1::text[])` 会报 "cannot cast type record to text[]"。
  const kindsSql = kinds.length
    ? sql`AND events.kind IN (${sql.join(
        kinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})`
    : sql``;
  const cursorSql =
    cursorAt && cursorRef
      ? sql`AND (events.occurred_at, events.ref_id) < (${cursorAt}::timestamptz, ${cursorRef}::uuid)`
      : sql``;

  const result = await db.execute<TimelineRow>(sql`
    WITH events AS (
      SELECT
        'quote'::text AS kind,
        quotes.id AS ref_id,
        quotes.id AS source_id,
        quotes.id::text AS code,
        quotes.status::text AS status,
        quotes.total_amount AS amount,
        quotes.currency::text AS currency,
        quotes.created_at AS occurred_at
      FROM quotes
      WHERE quotes.tenant_id = ${tenantId}
        AND quotes.customer_id = ${customerId}

      UNION ALL

      SELECT
        'sample_shipment'::text,
        sample_shipments.id,
        sample_shipments.id,
        sample_shipments.id::text,
        sample_shipments.status::text,
        NULL::bigint,
        NULL::text,
        sample_shipments.created_at
      FROM sample_shipments
      WHERE sample_shipments.tenant_id = ${tenantId}
        AND sample_shipments.customer_id = ${customerId}

      UNION ALL

      SELECT
        'order'::text,
        orders.id,
        orders.id,
        orders.code,
        orders.status::text,
        orders.total_amount,
        orders.currency::text,
        COALESCE(orders.confirmed_at, orders.created_at)
      FROM orders
      WHERE orders.tenant_id = ${tenantId}
        AND orders.customer_id = ${customerId}

      UNION ALL

      SELECT
        'receivable'::text,
        receivables.id,
        receivables.order_id,
        NULL::text,
        receivables.status::text,
        (receivables.amount - receivables.paid_amount)::bigint,
        receivables.currency::text,
        receivables.created_at
      FROM receivables
      WHERE receivables.tenant_id = ${tenantId}
        AND receivables.customer_id = ${customerId}

      UNION ALL

      SELECT
        'followup'::text,
        audit_log.id,
        ${customerId}::uuid,
        audit_log.action,
        audit_log.action,
        NULL::bigint,
        NULL::text,
        audit_log.created_at
      FROM audit_log
      WHERE audit_log.tenant_id = ${tenantId}
        AND audit_log.entity_id = ${customerId}::uuid
        AND audit_log.entity_type IN ('customer', 'customer_context')

      UNION ALL

      SELECT
        'inbound_reply'::text,
        inbound_messages.id,
        inbound_messages.id,
        inbound_messages.channel::text,
        'RECEIVED'::text,
        NULL::bigint,
        NULL::text,
        inbound_messages.received_at
      FROM inbound_messages
      WHERE inbound_messages.tenant_id = ${tenantId}
        AND inbound_messages.customer_id = ${customerId}::uuid
    )
    SELECT * FROM events
    WHERE true
      ${kindsSql}
      ${cursorSql}
    ORDER BY events.occurred_at DESC, events.ref_id DESC
    LIMIT ${limit + 1}
  `);

  const rows = result.rows;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const events = page.map((row) =>
    CustomerTimelineEvent.parse({
      id: `${row.kind}:${row.ref_id}`,
      kind: row.kind,
      refId: row.ref_id,
      sourceId: row.source_id,
      code: row.code,
      status: row.status,
      amount:
        row.amount === null
          ? null
          : { amount: Number(row.amount), currency: row.currency as Currency },
      occurredAt: isoOf(row.occurred_at),
    }),
  );
  const last = page[page.length - 1];
  return CustomerTimelinePage.parse({
    events,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({ occurredAt: isoOf(last.occurred_at), refId: last.ref_id })
        : null,
  });
}
