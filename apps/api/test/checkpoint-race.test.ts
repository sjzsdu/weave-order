import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCheckpointerCache, createPostgresCheckpointer } from "../src/platform/checkpoint";
import { EXECUTION_FAILURE_REASON } from "../src/platform/execution-error";
import { infrastructureFailure } from "../src/http/quote-agent.service";

/**
 * WAN-180：冷启动并发不应让报价 agent 失败。
 *
 * 两条守线：
 * 1. 同一连接池的并发首次调用只初始化一次检查点，失败可重试；
 * 2. 基础设施异常的原因不能写成「模型服务暂时不可用」（模型根本没被调用到）。
 */

describe("检查点初始化（进程内合并）", () => {
  it("并发首个调用共享同一个初始化，工厂只跑一次", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = async () => {
      calls += 1;
      await gate;
      return { name: `saver-${calls}` } as never;
    };
    const getCheckpointer = createCheckpointerCache(factory);
    const pool = {} as Pool;

    const pending = Promise.all([
      getCheckpointer(pool),
      getCheckpointer(pool),
      getCheckpointer(pool),
    ]);
    release();
    const results = await pending;

    expect(calls).toBe(1);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    // 缓存命中：后续请求不再走工厂。
    await getCheckpointer(pool);
    expect(calls).toBe(1);
  });

  it("初始化失败后清空缓存，下一次请求可以重试", async () => {
    let calls = 0;
    const factory = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("duplicate key"));
      return Promise.resolve({ name: "saver" } as never);
    };
    const getCheckpointer = createCheckpointerCache(factory);
    const pool = {} as Pool;

    await expect(getCheckpointer(pool)).rejects.toThrow("duplicate key");
    await expect(getCheckpointer(pool)).resolves.toEqual({ name: "saver" });
    expect(calls).toBe(2);
  });
});

describe("基础设施异常的失败原因", () => {
  it("不把基础设施异常说成模型不可用", () => {
    expect(EXECUTION_FAILURE_REASON).not.toContain("模型");
    expect(EXECUTION_FAILURE_REASON).toContain("原话还在");
    expect(EXECUTION_FAILURE_REASON).toContain("重试");
  });

  it("报价 agent 返回可重试的 FAILED，而不是抛错", () => {
    const result = infrastructureFailure("thread-1");
    expect(result.status).toBe("FAILED");
    expect(result.stage).toBe("FAILED");
    expect(result.failure).toMatchObject({ code: "INFRASTRUCTURE", node: "bootstrap" });
    expect(result.failure?.message).toBe(EXECUTION_FAILURE_REASON);
    expect(result.explanation).toBe(EXECUTION_FAILURE_REASON);
  });
});

/**
 * 真实数据库验证：空库上并发初始化。
 *
 * 修复前的最小复现是三个并发调用里两个 rejected（duplicate key ...
 * pg_type_typname_nsp_index）；这里用一个全新数据库确保是真正的 cold schema。
 * 没有数据库时跳过，不制造假红灯。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

let admin: Pool | null = null;
let target: Pool | null = null;
let targetUrl = "";
let available = false;
const dbName = `checkpoint_race_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

beforeAll(async () => {
  try {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query("SELECT 1");
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(DATABASE_URL);
    url.pathname = `/${dbName}`;
    targetUrl = url.toString();
    target = new Pool({ connectionString: targetUrl, max: 5 });
    await target.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await target?.end().catch(() => undefined);
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});

describe("检查点初始化（真实 Postgres，cold schema）", () => {
  it("并发首次调用全部成功", async (ctx) => {
    if (!available || !target) {
      ctx.skip();
      return;
    }
    const results = await Promise.allSettled([
      createPostgresCheckpointer(target),
      createPostgresCheckpointer(target),
      createPostgresCheckpointer(target),
    ]);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toEqual([]);

    // 表确实建好了，且后续从缓存取到的 saver 可读连接。
    const tables = await target.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(tables.rows.map((row) => row.table_name)).toContain("checkpoints");
  }, 30_000);
});
