import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 隔离铁律的机器守卫：
 * 1. 控制面源码不得 import 租户数据库包（@weave-order/db）；
 * 2. 控制面源码不得出现租户业务表名；
 * 3. 控制面 package.json 不依赖租户 db 包。
 */
const SRC = path.join(__dirname, "..", "src");
const FORBIDDEN_PACKAGE = "@weave-order/db";
const BUSINESS_TABLES = [
  "customers",
  "customer_contexts",
  "samples",
  "sample_embeddings",
  "sample_shipments",
  "quotes",
  "quote_lines",
  "quote_shares",
  "orders",
  "receivables",
  "revision_requests",
  "draft_revisions",
  "audit_log",
  "memberships",
  "token_usage",
  "usage_monthly",
];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("控制面隔离", () => {
  it("不 import 租户数据库包", async () => {
    const files = await walk(SRC);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content, `${file} 不应依赖租户业务库`).not.toContain(`"${FORBIDDEN_PACKAGE}"`);
      expect(content, `${file} 不应依赖租户业务库`).not.toContain(`'${FORBIDDEN_PACKAGE}'`);
    }
  });

  it("不引用任何租户业务表", async () => {
    const files = await walk(SRC);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const table of BUSINESS_TABLES) {
        // 只匹配明显的表引用：control 自己的 tenants/usage 表是账号级聚合，不在禁止清单。
        const pattern = new RegExp(`\\b${table}\\b`);
        expect(pattern.test(content), `${file} 出现了业务表 ${table}`).toBe(false);
      }
    }
  });

  it("package.json 不依赖租户 db 包", async () => {
    const pkg = JSON.parse(await readFile(path.join(__dirname, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.[FORBIDDEN_PACKAGE]).toBeUndefined();
    expect(pkg.dependencies?.["@weave-order/control-db"]).toBe("workspace:*");
  });
});
