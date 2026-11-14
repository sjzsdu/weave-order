#!/usr/bin/env node
/**
 * 分片 ESLint 执行器（WAN-127）。
 *
 * 为什么分片：根配置用 typescript-eslint 的 `projectService` 做类型感知检查，
 * 一个 `eslint .` 进程会把所有 workspace 的 TS Program 都留在堆里，峰值随仓库线性增长。
 * 2026-11-14 全仓一次跑需要约 4.2 GB RSS，撞穿 Node 默认 ~2 GB 堆上限后 OOM（exit 134），
 * 把 main 和所有 PR 的 `verify` 全挂掉。拆成「一个分片一个进程」后单分片峰值约 0.5~1.5 GB，
 * 内存随进程结束归还，后续代码增长也不会再把整条流水线拖死。
 *
 * 规则一行没改：分片之间只是进程边界，每个文件拿到的仍是同一份 eslint.config.mjs。
 * 因此这里唯一要守住的是「不漏文件」——下面会校验 apps/* 与 packages/* 每个目录恰好属于一个分片，
 * 新增 workspace 忘了登记会直接报错，而不是被悄悄跳过。
 *
 * 用法：
 *   node scripts/lint.mjs            # 跑全部分片
 *   node scripts/lint.mjs api web    # 只跑指定分片（本地调试更快）
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 分片表。原则：按「谁的代码谁负责」切，不按文件数量切，
 * 这样日志里直接能看出是哪个端的类型推导把内存吃掉了。
 */
const CHUNKS = [
  { name: "api", paths: ["apps/api"] },
  { name: "web", paths: ["apps/web"] },
  { name: "admin", paths: ["apps/admin"] },
  { name: "mobile", paths: ["apps/mobile"] },
  { name: "quote+site", paths: ["apps/quote", "apps/site"] },
  {
    name: "cli+platform-api+print-agent",
    paths: ["apps/cli", "apps/platform-api", "apps/print-agent"],
  },
  { name: "packages", paths: ["packages"] },
];

function fail(message) {
  console.error(`\n[lint] ${message}\n`);
  process.exit(1);
}

/** apps/* 与 packages/* 的每个目录都必须被某个分片覆盖，否则新增的端会静默漏检。 */
function assertFullCoverage(chunks) {
  // `packages` 这一片覆盖它下面的每个包，所以按前缀判定归属。
  const coveredBy = (workspace) =>
    chunks.some((chunk) =>
      chunk.paths.some((covered) => workspace === covered || workspace.startsWith(`${covered}/`)),
    );
  const workspaces = [];
  for (const group of ["apps", "packages"]) {
    const dir = path.join(root, group);
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        workspaces.push(`${group}/${entry.name}`);
      }
    }
  }
  const unowned = workspaces.filter((workspace) => !coveredBy(workspace));
  if (unowned.length > 0) {
    fail(
      `这些 workspace 没有被任何 lint 分片覆盖：${unowned.join("、")}。\n` +
        `请在 scripts/lint.mjs 的 CHUNKS 里登记后再提交（漏检比报错更贵）。`,
    );
  }

  // 仓库根目录若出现 TS 文件（不属于任何 workspace），也要显式登记。
  const rootTs = readdirSync(root).filter(
    (name) => /\.(ts|tsx)$/.test(name) && statSync(path.join(root, name)).isFile(),
  );
  if (rootTs.length > 0) {
    fail(`仓库根目录出现了不在任何 workspace 里的 TS 文件：${rootTs.join("、")}，请并入某个分片。`);
  }
}

/** 读 Linux 的 VmHWM（进程生命周期内 RSS 峰值）。其他平台返回 0。 */
function readPeakRssKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmHWM:\s+(\d+) kB$/m);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function gb(kb) {
  return (kb / 1024 / 1024).toFixed(2);
}

/**
 * 水位线：默认 V8 堆上限约 2 GB，单分片超过 1.6 GB（80%）就贴到墙了。
 * 不直接拉红（避免和真实 lint 错误混在一起），但要在日志里喊一声，
 * 让下次加代码的人知道「该再切一刀」而不是等 OOM 回来。
 */
const WATERMARK_KB = 1.6 * 1024 * 1024;

async function runChunk(chunk, eslintBin) {
  const args = [...chunk.paths, "--no-error-on-unmatched-pattern"];
  const startedAt = Date.now();
  const child = spawn(eslintBin, args, { cwd: root, stdio: "inherit", env: process.env });

  let peakKb = 0;
  // 100ms 采样足够抓住峰值（OOM 前的增长是秒级的），又不会自己吃掉 CPU。
  const timer = setInterval(() => {
    const kb = readPeakRssKb(child.pid);
    if (kb > peakKb) {
      peakKb = kb;
    }
  }, 100);

  const code = await new Promise((resolve) =>
    child.on("exit", (exitCode) => resolve(exitCode ?? 1)),
  );
  clearInterval(timer);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const peak = peakKb > 0 ? `${gb(peakKb)} GB` : "n/a";
  console.log(
    `[lint] ${chunk.name}: ${code === 0 ? "ok" : `失败(exit ${code})`} · ${seconds}s · 峰值 RSS ${peak}`,
  );
  if (peakKb > WATERMARK_KB) {
    console.warn(
      `[lint] 水位告警：${chunk.name} 峰值 ${gb(peakKb)} GB，已超 1.6 GB 预算。\n` +
        `        分片内存是不均时的长板，请把它再拆小，否则下一次代码增长会在 CI 上直接 OOM。`,
    );
  }
  return { code, peakKb, seconds: Number(seconds) };
}

console.log(
  `[lint] node ${process.version} · ${os.cpus().length} 核 · ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM` +
    ` · V8 堆上限 ${(v8.getHeapStatistics().heap_size_limit / 1024 ** 2).toFixed(0)} MB`,
);

const only = process.argv.slice(2);
const selected = only.length > 0 ? CHUNKS.filter((chunk) => only.includes(chunk.name)) : CHUNKS;
if (selected.length === 0) {
  fail(`没有匹配的分片：${only.join("、")}。可用：${CHUNKS.map((chunk) => chunk.name).join("、")}`);
}
if (only.length === 0) {
  assertFullCoverage(CHUNKS);
}

const eslintBin =
  process.platform === "win32"
    ? path.join(root, "node_modules", ".bin", "eslint.cmd")
    : path.join(root, "node_modules", ".bin", "eslint");

const results = [];
for (const chunk of selected) {
  results.push({ chunk, ...(await runChunk(chunk, eslintBin)) });
}

const failed = results.filter((result) => result.code !== 0);
const peak = Math.max(...results.map((result) => result.peakKb));
const total = results.reduce((sum, result) => sum + result.seconds, 0);
console.log(
  `[lint] ${results.length} 个分片，总计 ${total.toFixed(1)}s，单分片峰值 ${peak > 0 ? `${gb(peak)} GB` : "n/a"}`,
);

if (failed.length > 0) {
  fail(`分片失败：${failed.map((result) => result.chunk.name).join("、")}`);
}
