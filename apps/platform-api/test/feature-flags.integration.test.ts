import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformDb, featureFlags, resolvePlatformDatabaseUrl } from "@weave-order/control-db";
import type { PlatformDb } from "@weave-order/control-db";
import { AccountExecutor } from "./helpers/actor";
import { AuditService } from "../src/control/audit.service";
import { SettingsService } from "../src/control/settings.service";
import type { PlatformError } from "../src/domain/errors";

/**
 * 管理端创建功能开关：WAN-171。
 *
 * 空控制面下 `POST /platform/api/settings/feature-flags` 是唯一冷启动入口，
 * 这里验证：能创建、重复 key 报 CONFLICT、非法 key 被拒绝、创建写审计。
 * 没有控制面库时整组跳过，离线 `pnpm test` 仍然全绿。
 */
const URL = process.env.PLATFORM_DATABASE_URL ?? resolvePlatformDatabaseUrl();
let db: PlatformDb | null = null;
let pool: ReturnType<typeof createPlatformDb>["pool"] | null = null;
let available = false;

let settings: SettingsService;
let audit: AuditService;

const owner = AccountExecutor("wan171-owner", "platform_owner");
const created: string[] = [];

beforeAll(async () => {
  try {
    const handle = createPlatformDb(URL);
    pool = handle.pool;
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('control.feature_flags') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (!available) {
      await pool.end();
      pool = null;
      return;
    }
    db = handle.db;
    audit = new AuditService(db);
    settings = new SettingsService(db, audit);
  } catch {
    available = false;
    await pool?.end();
    pool = null;
  }
});

afterAll(async () => {
  if (db && created.length > 0) {
    await db.delete(featureFlags).where(inArray(featureFlags.key, created));
  }
  await pool?.end();
});

const newKey = () => `wan171.${randomUUID().slice(0, 8)}`;

describe("创建功能开关（集成）", () => {
  it("空环境可以创建第一个开关，并立即出现在列表里", async (ctx) => {
    if (!available) ctx.skip();
    const key = newKey();
    created.push(key);

    const flag = await settings.createFlag(owner, {
      key,
      name: "超额用量预览",
      description: "灰度给部分租户",
      enabled: true,
      rolloutPercent: 25,
      tenantIds: [],
    });
    expect(flag).toMatchObject({
      key,
      name: "超额用量预览",
      description: "灰度给部分租户",
      enabled: true,
      rolloutPercent: 25,
      updatedBy: owner.sub,
    });

    const list = await settings.listFlags();
    expect(list.map((item) => item.key)).toContain(key);
  });

  it("重复 key 返回 CONFLICT，且不覆盖已有配置", async (ctx) => {
    if (!available) ctx.skip();
    const key = newKey();
    created.push(key);
    await settings.createFlag(owner, { key, name: "第一版", rolloutPercent: 10 });

    await expect(
      settings.createFlag(owner, { key, name: "第二版", enabled: true, rolloutPercent: 90 }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<PlatformError>);

    const list = await settings.listFlags();
    const row = list.find((item) => item.key === key);
    expect(row?.name).toBe("第一版");
    expect(row?.rolloutPercent).toBe(10);
  });

  it("非法 key 被拒绝（不会写进控制面）", async (ctx) => {
    if (!available) ctx.skip();
    const key = "-bad key";
    await expect(settings.createFlag(owner, { key, name: "非法" })).rejects.toThrow();
    const list = await settings.listFlags();
    expect(list.map((item) => item.key)).not.toContain(key);
  });

  it("创建与回滚都会写入平台审计", async (ctx) => {
    if (!available) ctx.skip();
    const key = newKey();
    created.push(key);
    await settings.createFlag(owner, { key, name: "审计开关", enabled: true, rolloutPercent: 50 });
    await settings.updateFlag(owner, key, { enabled: false, rolloutPercent: 0, tenantIds: [] });

    const entries = await audit.list(50, { targetId: key });
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain("FEATURE_FLAG_CREATED");
    expect(actions).toContain("FEATURE_FLAG_UPDATED");
  });
});
