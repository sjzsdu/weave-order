#!/usr/bin/env node
/**
 * 根入口：`pnpm demo:reset`。
 *
 * 真正的重置逻辑在 `apps/api/scripts/demo-reset.ts`：那里能直接复用
 * `@weave-order/schema` 的 `canResetDemoData`、内核的媒体治理与 Redis 客户端，
 * 避免根脚本再抄一份环境判定。这里只负责转发参数与退出码。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

if (!existsSync(path.join(root, "pnpm-workspace.yaml"))) {
  console.error("✖ 找不到仓库根（pnpm-workspace.yaml）");
  process.exit(1);
}

const result = spawnSync(
  "pnpm",
  ["--filter", "@weave-order/api", "demo:reset", ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit", env: process.env, shell: process.platform === "win32" },
);
process.exit(result.status ?? 1);
