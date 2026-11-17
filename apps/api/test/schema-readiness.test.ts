import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AppDatabaseProvider } from "../src/platform/database.provider";
import { EXPECTED_TABLES, SchemaReadinessProbe } from "../src/platform/schema-readiness";

type TableRow = { relname: string; can_select: boolean };

function probeWith(present: string[] | TableRow[] | "error"): SchemaReadinessProbe {
  const pool = {
    query: (_sql: string, params: unknown[]): Promise<{ rows: TableRow[] }> => {
      if (present === "error") return Promise.reject(new Error("connection refused"));
      const rows: TableRow[] = Array.isArray(present)
        ? present.map((entry) =>
            typeof entry === "string" ? { relname: entry, can_select: true } : entry,
          )
        : [];
      void params;
      return Promise.resolve({ rows });
    },
  };
  return new SchemaReadinessProbe({ pool } as unknown as AppDatabaseProvider);
}

describe("数据库结构就绪探针", () => {
  it("期望的表来自 Drizzle schema：新增迁移里的表自动纳入", () => {
    // 0019 / 0020 就是生产漏跑的那两条，必须被覆盖到。
    expect(EXPECTED_TABLES).toContain("intents");
    expect(EXPECTED_TABLES).toContain("onboarding_state");
  });

  it("全部存在 -> ok", async () => {
    const readiness = await probeWith([...EXPECTED_TABLES]).check(true);
    expect(readiness).toMatchObject({ ok: true, missing: [], denied: [] });
  });

  it("缺表 -> 报出具体名字，不再假装健康", async () => {
    const present = EXPECTED_TABLES.filter((name) => name !== "intents");
    const readiness = await probeWith(present).check(true);
    expect(readiness.ok).toBe(false);
    expect(readiness.missing).toEqual(["intents"]);
  });

  it("表在但没有 SELECT 权限 -> denied（WAN-147 的真实形态）", async () => {
    const rows = EXPECTED_TABLES.map((relname) => ({
      relname,
      can_select: relname !== "intents",
    }));
    const readiness = await probeWith(rows).check(true);
    expect(readiness.ok).toBe(false);
    expect(readiness.missing).toEqual([]);
    expect(readiness.denied).toEqual(["intents"]);
  });

  it("连不上库 -> 标成未知（ok=false + error），不当成正常", async () => {
    const readiness = await probeWith("error").check(true);
    expect(readiness.ok).toBe(false);
    expect(readiness.error).toContain("connection refused");
  });

  it("启动断言：缺表且要求硬门禁时抛错，否则只记错误日志", async () => {
    // 这条断言本来就要打一条 ERROR 日志，测试输出里不需要它。
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const probe = probeWith([]);
      await expect(probe.assertAtBoot(true)).rejects.toThrow(/数据库结构落后/);
      await expect(probe.assertAtBoot(false)).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("启动断言：只有权限缺失时，日志说的是缺权限而不是缺表", async () => {
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const rows = EXPECTED_TABLES.map((relname) => ({
        relname,
        can_select: relname !== "intents",
      }));
      await probeWith(rows).assertAtBoot(false);
      expect(logged.mock.calls[0]?.[0]).toContain("数据库权限缺失");
    } finally {
      logged.mockRestore();
    }
  });

  it("结果有短缓存，健康检查不会每次都打库", async () => {
    let calls = 0;
    const pool = {
      query: (): Promise<{ rows: TableRow[] }> => {
        calls += 1;
        return Promise.resolve({ rows: [] });
      },
    };
    const probe = new SchemaReadinessProbe({ pool } as unknown as AppDatabaseProvider);
    await probe.check();
    await probe.check();
    expect(calls).toBe(1);
    await probe.check(true);
    expect(calls).toBe(2);
  });
});
