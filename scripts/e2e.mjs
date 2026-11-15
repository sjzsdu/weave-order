#!/usr/bin/env node
/**
 * 一键端到端验收：准备本地依赖 → 构建 → Playwright 跑 3 档桌面视口 + 移动 H5。
 *
 * 设计原则：
 * - 「一条命令可重复跑」：所有数据种子都在 e2e/support/seed.ts 里幂等创建；
 * - 不替人做决定：真机相机权限 / 视觉观感只写进 docs/e2e-acceptance.md 的 10 分钟清单；
 * - 不改业务代码取巧：测试服务用独立端口（3100/3101/3102），不碰日常 dev 服务。
 *
 * 可跳过的外部依赖：
 *   E2E_SKIP_STORAGE=1    已自行起好 MinIO / S3（脚本不再拉本地二进制）
 *   E2E_SKIP_MIGRATE=1    数据库已迁移
 *   E2E_SKIP_BUILD=1      已构建过 web / mobile（调试单条 spec 时用）
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3100";
const MEDIA_BASE_URL = process.env.E2E_MEDIA_BASE_URL ?? "http://127.0.0.1:9000/weave-media";

function log(step) {
  console.log(`\n[e2e] ${step}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.status !== 0) {
    console.error(
      `\n[e2e] 失败：${command} ${args.join(" ")}（exit ${result.status ?? "signal"}）`,
    );
    process.exit(result.status ?? 1);
  }
}

/**
 * 专用端口上可能残留上一次中断的进程（或误连到旧构建）。
 * 只清理 3100/3101/3102 这三个 E2E 端口，绝不碰 3000/3001 日常开发服务。
 */
function freeE2ePorts() {
  for (const port of [3100, 3101, 3102]) {
    // fuser 能处理 lsof 偶发漏报（例如 next-server 改过进程名）的情况。
    spawnSync("fuser", ["-k", "-n", "tcp", String(port)], { stdio: "ignore" });
    const found = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" });
    const pids = (found.stdout ?? "")
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`  释放端口 ${port}（结束残留进程 ${pid}）`);
      } catch {
        // 进程可能在枚举与 kill 之间自己退出。
      }
    }
  }
}

async function storageReady() {
  try {
    const response = await fetch(`${S3_ENDPOINT.replace(/\/$/, "")}/minio/health/live`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  log("0/4 检查本地对象存储");
  if (process.env.E2E_SKIP_STORAGE === "1") {
    console.log("  已跳过（E2E_SKIP_STORAGE=1，假定外部 S3/MinIO 就绪）");
  } else if (await storageReady()) {
    console.log(`  已就绪：${S3_ENDPOINT}`);
  } else if (process.env.E2E_MINIO_MODE === "docker") {
    run("docker", ["compose", "--profile", "media", "up", "-d", "minio", "minio-init"]);
  } else {
    console.log("  未检测到 MinIO：用 scripts/dev-storage-up.sh 起本地二进制（首次约 135MB）");
    run("bash", ["scripts/dev-storage-up.sh"]);
  }

  log("1/4 数据库迁移（幂等）");
  if (process.env.E2E_SKIP_MIGRATE === "1") console.log("  已跳过（E2E_SKIP_MIGRATE=1）");
  else run("pnpm", ["db:migrate"]);

  log("2/4 构建 web / mobile（Taro 产物关 mock、指向测试 API）");
  if (process.env.E2E_SKIP_BUILD === "1") {
    console.log("  已跳过（E2E_SKIP_BUILD=1）");
  } else {
    run("pnpm", ["build"]);
    run("pnpm", ["--filter", "@weave-order/mobile", "build"], {
      env: { TARO_APP_API_BASE: API_URL },
    });
  }

  log("3/4 确认 Playwright Chromium 可用");
  if (process.env.E2E_SKIP_BROWSER_INSTALL === "1") {
    console.log("  已跳过（E2E_SKIP_BROWSER_INSTALL=1）");
  } else {
    run("pnpm", ["exec", "playwright", "install", "chromium"]);
  }

  log("4/4 跑 Playwright（API / Web / H5 由配置里的 webServer 拉起）");
  if (process.env.E2E_REUSE_SERVERS !== "1") freeE2ePorts();
  run("pnpm", ["exec", "playwright", "test", "--config", "e2e/playwright.config.ts"], {
    env: {
      E2E_API_URL: API_URL,
      E2E_MEDIA_BASE_URL: MEDIA_BASE_URL,
    },
  });

  log("完成：截图与 HTML 报告在 e2e/.artifacts/");
  if (!existsSync(path.join(ROOT, "e2e/.artifacts/screenshots"))) {
    console.log("  注意：没有找到截图目录，检查 spec 是否真的执行了");
  }
}

await main();
