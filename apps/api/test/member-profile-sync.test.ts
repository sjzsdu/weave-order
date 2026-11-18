import { describe, expect, it } from "vitest";
import type { Db } from "@weave-order/db";
import { TenancyService } from "../src/kernel/tenancy.service";

/**
 * WAN-151：登录 claims 里的姓名可能是 UUID（部分 IdP 用 sub 回填 name）。
 * 落库前必须挡住，否则「负责人」又会变成一串技术主键。
 */

const SUBJECT = "9ba015a8-70a3-49e3-a7d9-73cdab4c0fac";
const TENANT = "8a4a6a7e-1111-4222-8333-444455556667";

function fakeDb(current: { displayName: string | null; email: string | null }) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([current]),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Db;
  return { db, updates };
}

describe("syncMemberProfile", () => {
  it("姓名是 UUID 时不落库", async () => {
    const { db, updates } = fakeDb({ displayName: null, email: null });
    await new TenancyService(db).syncMemberProfile(SUBJECT, TENANT, {
      displayName: SUBJECT,
      email: null,
    });
    expect(updates).toHaveLength(0);
  });

  it("用登录 claims 的姓名与邮箱补全副本", async () => {
    const { db, updates } = fakeDb({ displayName: null, email: null });
    await new TenancyService(db).syncMemberProfile(SUBJECT, TENANT, {
      displayName: "haibao",
      email: "122828837@qq.com",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ displayName: "haibao", email: "122828837@qq.com" });
  });

  it("值没变化不产生 UPDATE（/api/auth/me 是热路径）", async () => {
    const { db, updates } = fakeDb({ displayName: "haibao", email: "122828837@qq.com" });
    await new TenancyService(db).syncMemberProfile(SUBJECT, TENANT, {
      displayName: "haibao",
      email: "122828837@qq.com",
    });
    expect(updates).toHaveLength(0);
  });

  it("claims 缺字段时不清空已有值", async () => {
    const { db, updates } = fakeDb({ displayName: "haibao", email: "122828837@qq.com" });
    await new TenancyService(db).syncMemberProfile(SUBJECT, TENANT, {
      displayName: "haibao",
      email: null,
    });
    expect(updates).toHaveLength(0);
  });
});
