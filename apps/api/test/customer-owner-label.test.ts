import { describe, expect, it } from "vitest";
import type { Db } from "@weave-order/db";
import { loadCustomerList } from "../src/kernel/customer-aggregates";
import { isTechnicalId, memberDisplayName } from "../src/kernel/member-label";

/**
 * WAN-151：客户列表 / 客户 360 的「负责人」曾经直接回传 `memberships.subject`
 * （SSO 主键 UUID）。这条测试锁死两层防线：展示名不带 UUID，SQL 不再取 subject。
 */

const SSO_SUBJECT = "9ba015a8-70a3-49e3-a7d9-73cdab4c0fac";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function listRow(ownerName: string | null) {
  return {
    id: "8a4a6a7e-1111-4222-8333-444455556666",
    tenant_id: "8a4a6a7e-1111-4222-8333-444455556667",
    code: "C261117-0001",
    name: "走查测试客户",
    tier: "NEW",
    contact_name: null,
    contact_phone: null,
    contact_email: null,
    owner_id: "8a4a6a7e-1111-4222-8333-444455556668",
    owner_name: ownerName,
    pending_quote_count: 0,
    in_transit_sample_count: 0,
    active_order_count: 0,
    receivable_balance: [],
    overdue_receivable_count: 0,
    last_contact_at: null,
  };
}

function stubDb(row: ReturnType<typeof listRow>): Db {
  return {
    execute: () => Promise.resolve({ rows: [row] }),
  } as unknown as Db;
}

/** drizzle 的 SQL 对象把原始片段放在 StringChunk.value 里；把字符串片段拼起来便于断言。 */
function sqlText(query: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object" && "value" in value) {
      const nested = (value as { value?: unknown }).value;
      if (typeof nested === "string") parts.push(nested);
      else if (Array.isArray(nested)) nested.forEach(walk);
    }
  };
  walk((query as { queryChunks?: unknown[] }).queryChunks ?? []);
  return parts.join("");
}

describe("客户负责人展示名", () => {
  it("SQL 不再把 subject 当姓名：查询里没有 memberships.subject AS owner_name", async () => {
    // 用一个记录 SQL 的假 db 反查生成的语句，防止以后有人改回旧写法。
    const statements: string[] = [];
    const db = {
      execute: (query: unknown) => {
        statements.push(sqlText(query));
        return Promise.resolve({ rows: [listRow("haibao")] });
      },
    } as unknown as Db;
    await loadCustomerList(db, listRow(null).tenant_id, { limit: 5 });
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain("memberships.subject");
    expect(statements[0]).toContain("display_name");
  });

  it("姓名副本正常时直接显示姓名", async () => {
    const [item] = await loadCustomerList(stubDb(listRow("haibao")), listRow(null).tenant_id, {
      limit: 5,
    });
    expect(item?.ownerName).toBe("haibao");
  });

  it("姓名为空时回退到邮箱", async () => {
    const [item] = await loadCustomerList(
      stubDb(listRow("122828837@qq.com")),
      listRow(null).tenant_id,
      { limit: 5 },
    );
    expect(item?.ownerName).toBe("122828837@qq.com");
  });

  it("历史脏数据里 owner_name 是 UUID 时，返回 null 而不是 UUID", async () => {
    const [item] = await loadCustomerList(stubDb(listRow(SSO_SUBJECT)), listRow(null).tenant_id, {
      limit: 5,
    });
    expect(item?.ownerName).toBeNull();
    expect(item?.ownerName ?? "").not.toMatch(UUID_PATTERN);
  });

  it("无负责人时返回 null", async () => {
    const [item] = await loadCustomerList(stubDb(listRow(null)), listRow(null).tenant_id, {
      limit: 5,
    });
    expect(item?.ownerName).toBeNull();
  });
});

describe("memberDisplayName", () => {
  it("跳过 UUID，取第一个可展示的候选值", () => {
    expect(memberDisplayName(SSO_SUBJECT, "122828837@qq.com")).toBe("122828837@qq.com");
    expect(memberDisplayName(null, "", "  haibao  ")).toBe("haibao");
    expect(memberDisplayName(SSO_SUBJECT, null)).toBeNull();
  });

  it("识别 SSO 主键与 32 位内部 id", () => {
    expect(isTechnicalId(SSO_SUBJECT)).toBe(true);
    expect(isTechnicalId("9ba015a870a349e3a7d973cdab4c0fac")).toBe(true);
    expect(isTechnicalId("haibao")).toBe(false);
    expect(isTechnicalId("122828837@qq.com")).toBe(false);
  });
});
