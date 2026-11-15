#!/usr/bin/env node
/**
 * 本地 dev 统一入口（WAN-134）。
 *
 * 为什么不用 `turbo run dev` 一把梭：九个 workspace 里只有七个是「有 URL 的服务」。
 *   - `cli`（tsx src/main.ts）是交互式终端程序，`print-agent`（tauri dev）要 Rust 工具链，
 *     混进主命令会让 `pnpm dev` 直接阻塞或在这台机器上起不来 —— 它们各有独立入口
 *     （`dev:cli` / `dev:desktop`）。
 *   - `mobile` 的 `taro build --type h5 --watch` 自带 webpack-dev-server（默认 10086），
 *     地址不是各端自己打印的那一套；这里统一纳管并写进清单。
 *
 * 本脚本负责：基础设施预检 → 迁移 → 共享包构建 → 并行拉起各端 → 逐个探测就绪 →
 * 最后**只打印一张** URL 清单（含 health 端点）。子进程按进程组管理，Ctrl-C 一并回收。
 *
 * 用法：
 *   pnpm dev                    # 全部 URL 端 + 移动端 H5 预览
 *   pnpm dev web api            # 只起指定端（日志前缀同名）
 *   pnpm dev --no-mobile        # 跳过 Taro watch（省 CPU/内存）
 *   pnpm dev --no-infra         # 不自动起 docker compose 的 postgres/redis
 *   pnpm dev --no-migrate       # 不跑数据库迁移（更快，但库里没表时 API health 会 500）
 *   pnpm dev --no-build         # 不重新构建共享包（依赖已构建过时）
 *   pnpm dev --list             # 只打印计划启动的清单，不起进程
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IS_WINDOWS = process.platform === "win32";

/**
 * 「有 URL」的端。顺序即清单顺序：先看业务面，再看管理面，最后移动端。
 * port 与各 app 里写死的端口保持一致（改端口要同时改这里和 app 的 dev 脚本）。
 * healthPath 是本地无登录态也能拿到 <400 的地址：
 *   - 后端用真正的 /health；
 *   - Next 端用登录页（`/` 会 307，也算在监听，但登录页能顺带预热首屏编译）；
 *   - quote 挂 basePath /s 且只有 /s/[token]，根路径是 404，用一个形状非法的 token 探活；
 *   - 静态站与移动端探 /。
 */
export const SERVICES = [
  {
    key: "api",
    label: "API 内核",
    pkg: "@weave-order/api",
    port: 3000,
    baseUrl: "http://localhost:3000",
    healthPath: "/api/health",
    env: { PORT: "3000" },
  },
  {
    key: "web",
    label: "工作台 web",
    pkg: "@weave-order/web",
    port: 3001,
    baseUrl: "http://localhost:3001",
    healthPath: "/login",
  },
  {
    key: "quote",
    label: "客户报价 quote",
    pkg: "@weave-order/quote",
    port: 5174,
    baseUrl: "http://localhost:5174",
    urlPath: "/s/<token>",
    // quote 只有 /s/[token] 一个页面，basePath 根 /s 是 404；用一个形状非法的
    // token 命中「链接无效」页（200，且不请求 API），才是不依赖后端的存活探针。
    healthPath: "/s/dev-readiness",
  },
  {
    key: "admin",
    label: "平台控制台 admin",
    pkg: "@weave-order/admin",
    port: 3003,
    baseUrl: "http://localhost:3003",
    healthPath: "/login",
  },
  {
    key: "site",
    label: "官网 site",
    pkg: "@weave-order/site",
    port: 4321,
    baseUrl: "http://localhost:4321",
    healthPath: "/",
  },
  {
    key: "platform-api",
    label: "平台控制面 API",
    pkg: "@weave-order/platform-api",
    port: 3002,
    baseUrl: "http://localhost:3002",
    healthPath: "/platform/api/health",
    env: { PORT: "3002" },
  },
  {
    key: "mobile",
    label: "移动端 H5",
    pkg: "@weave-order/mobile",
    // Taro H5 的 `build --watch` 自带 webpack-dev-server（内存产物，默认 10086），
    // 不是「只写 dist 的构建」——所以不需要再补静态服务器。
    port: 10086,
    baseUrl: "http://localhost:10086",
    healthPath: "/",
    env: { TARO_APP_API_BASE: "http://localhost:3000" },
  },
];

/** 不是 URL 服务、故意不主 dev 启动的端：给独立入口。 */
export const NON_URL_SERVICES = [
  { key: "cli", label: "命令行 cli（交互式）", script: "dev:cli" },
  { key: "print-agent", label: "打印代理 print-agent（Tauri）", script: "dev:desktop" },
];

/* ------------------------------------------------------------------ 参数 */
export function parseArgs(argv) {
  const options = {
    infra: true,
    migrate: true,
    build: true,
    mobile: true,
    list: false,
    timeoutMs: 180_000,
    only: [],
  };
  for (const arg of argv) {
    if (arg === "--no-infra") options.infra = false;
    else if (arg === "--no-migrate") options.migrate = false;
    else if (arg === "--no-build") options.build = false;
    else if (arg === "--no-mobile") options.mobile = false;
    else if (arg === "--list") options.list = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--timeout=")) {
      const seconds = Number(arg.slice("--timeout=".length));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--timeout 需要正整数秒`);
      options.timeoutMs = seconds * 1000;
    } else if (arg.startsWith("--only=")) {
      options.only.push(...arg.slice("--only=".length).split(","));
    } else if (arg.startsWith("-")) {
      throw new Error(`未知参数：${arg}`);
    } else {
      options.only.push(arg);
    }
  }
  return options;
}

export function selectServices(options) {
  const wanted = options.only.map((key) => key.trim()).filter(Boolean);
  if (wanted.length === 0) {
    return options.mobile ? SERVICES : SERVICES.filter((service) => service.key !== "mobile");
  }
  const known = new Set(SERVICES.map((service) => service.key));
  const unknown = wanted.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`未知的端：${unknown.join(", ")}（可选：${[...known].join(", ")}）`);
  }
  return SERVICES.filter((service) => wanted.includes(service.key));
}

/* ------------------------------------------------------------------ 输出 */
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const COLORS = [36, 35, 32, 33, 34, 96, 95];
const dim = (text) => (useColor ? `\x1b[2m${text}\x1b[0m` : text);
const green = (text) => (useColor ? `\x1b[32m${text}\x1b[0m` : text);
const red = (text) => (useColor ? `\x1b[31m${text}\x1b[0m` : text);
const yellow = (text) => (useColor ? `\x1b[33m${text}\x1b[0m` : text);

const log = (message) => console.log(`[dev] ${message}`);

function tagColor(key) {
  const index = SERVICES.findIndex((service) => service.key === key);
  return COLORS[(index < 0 ? 0 : index) % COLORS.length];
}

/**
 * 终端显示宽度：中文/全角按 2 列算，否则表格在中文标签下会错位。
 * 只覆盖本脚本会出现的字符集（CJK、全角标点、常见符号），不引第三方 wcwidth。
 */
export function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}

function pad(text, width) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function displayUrl(service) {
  const suffix = service.urlPath ?? "";
  return `${service.baseUrl}${suffix}`;
}

/**
 * 渲染最终清单。状态列用文本而不是 emoji，避免不同终端宽度不一致。
 */
export function renderTable(services, states) {
  const headers = ["端", "地址", "健康检查", "状态"];
  const rows = services.map((service) => {
    const state = states.get(service.key);
    const status = state?.status;
    const http = state?.httpStatus ? ` ${state.httpStatus}` : "";
    const statusText =
      status === undefined
        ? "未启动"
        : status === "ready"
          ? `就绪${http}`
          : status === "failed"
            ? `未就绪${state.detail ? `（${state.detail}）` : ""}`
            : status === "stopped"
              ? "已退出"
              : "启动中";
    return [service.label, displayUrl(service), service.healthPath, statusText];
  });
  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[column]))),
  );
  const line = (left, middle, right) =>
    left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right;
  const formatRow = (cells) =>
    "│ " + cells.map((cell, column) => pad(cell, widths[column])).join(" │ ") + " │";
  const lines = [
    line("┌", "┬", "┐"),
    formatRow(headers),
    line("├", "┼", "┤"),
    ...rows.map(formatRow),
    line("└", "┴", "┘"),
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------------ 进程工具 */
function pnpmCommand() {
  return IS_WINDOWS ? "pnpm.cmd" : "pnpm";
}

function assertToolchain() {
  const version = process.versions.node.split(".").map(Number);
  if (version[0] < 20) {
    throw new Error(`需要 Node >= 20（当前 ${process.versions.node}）`);
  }
  if (!existsSync(path.join(REPO_ROOT, "node_modules"))) {
    throw new Error("缺少依赖：先在仓库根目录运行 `pnpm install`");
  }
  const result = spawnSync(pnpmCommand(), ["--version"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: IS_WINDOWS,
  });
  if (result.status !== 0) {
    throw new Error("找不到 pnpm：先运行 `corepack enable`（仓库用 pnpm 管理 workspace）");
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connectOnce(port, host, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}

/**
 * 双栈探测：Astro dev 默认只监听 ::1（IPv6 localhost），只看 127.0.0.1 会永远判定未就绪。
 */
async function isPortOpen(port) {
  return (await connectOnce(port, "127.0.0.1")) || (await connectOnce(port, "::1"));
}

function runStep(label, command, args, { timeoutMs = 300_000 } = {}) {
  log(`${label}…`);
  // 一次性步骤（构建/迁移）直接继承 stdio：进度与报错原样给用户，不吞日志。
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: timeoutMs,
    shell: IS_WINDOWS,
  });
  if (result.status !== 0) {
    log(red(`${label}失败（退出码 ${result.status ?? "timeout"}）`));
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ 基础设施 */
function envValue(name, fallback) {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function urlEndpoint(value, fallbackPort) {
  try {
    const url = new URL(value);
    return { host: url.hostname, port: Number(url.port) || fallbackPort };
  } catch {
    return { host: "localhost", port: fallbackPort };
  }
}

async function ensureInfra(options) {
  const database = urlEndpoint(
    envValue("DATABASE_URL", "postgres://weave:weave@localhost:5433/weave_order"),
    5433,
  );
  const redis = urlEndpoint(envValue("REDIS_URL", "redis://localhost:6380"), 6380);
  // 远程库（staging/共享开发库）不归本机 docker 管，直接当作可用；连不上由各端自己报错。
  const isLoopback = (host) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  if (!isLoopback(database.host) || !isLoopback(redis.host)) {
    log(
      `使用外部基础设施（postgres:${database.host}:${database.port} / redis:${redis.host}:${redis.port}），跳过本地启动`,
    );
    // 远程库绝不自动迁移：一行 `pnpm dev` 不该把迁移打到 staging/共享库上。
    return "remote";
  }
  const targets = [
    { name: "postgres", port: database.port },
    { name: "redis", port: redis.port },
  ];
  const missing = [];
  for (const target of targets) {
    if (!(await isPortOpen(target.port))) missing.push(target);
  }
  if (missing.length === 0) {
    log(`基础设施已就绪（${targets.map((t) => `${t.name}:${t.port}`).join(" / ")}）`);
    return "local";
  }
  if (!options.infra) {
    log(
      yellow(
        `基础设施未就绪：${missing.map((t) => `${t.name}:${t.port}`).join(", ")}（已用 --no-infra 跳过启动）`,
      ),
    );
    return false;
  }
  const result = spawnSync("docker", ["--version"], { encoding: "utf8", shell: IS_WINDOWS });
  if (result.status !== 0) {
    log(yellow("未找到 docker，跳过基础设施启动；API 健康检查可能会失败"));
    return false;
  }
  log(`启动本地基础设施：docker compose up -d ${missing.map((t) => t.name).join(" ")}`);
  const compose = spawnSync(
    "docker",
    ["compose", "up", "-d", ...missing.map((target) => target.name)],
    { cwd: REPO_ROOT, encoding: "utf8", shell: IS_WINDOWS, timeout: 300_000 },
  );
  if (compose.status !== 0) {
    const output = `${compose.stdout ?? ""}${compose.stderr ?? ""}`.trim().split("\n").slice(-8);
    log(yellow("docker compose 启动失败（可手动 `docker compose up -d postgres redis`）"));
    for (const line of output) console.error(dim(`  ${line}`));
    if (output.join("\n").includes("already in use")) {
      log(
        yellow(
          "容器名被别的 checkout 占用了（同一台机器上跑过多套仓库时常见）：" +
            "`docker ps -a --filter name=weave-order` 查一下，或先 `docker rm -f weave-order-postgres weave-order-redis`",
        ),
      );
    }
    return false;
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const stillDown = [];
    for (const target of missing) {
      if (!(await isPortOpen(target.port))) stillDown.push(target);
    }
    if (stillDown.length === 0) {
      log("基础设施就绪");
      return "local";
    }
    await sleep(1000);
  }
  log(yellow("基础设施 90 秒内未就绪，继续启动（相关端可能会失败）"));
  return false;
}

/* ------------------------------------------------------------------ 子进程 */
const children = [];
let shuttingDown = false;

function pipePrefixed(stream, key, target) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const prefix = useColor ? `\x1b[${tagColor(key)}m[${key}]\x1b[0m` : `[${key}]`;
      target.write(`${prefix} ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffer.trim() !== "") {
      const prefix = useColor ? `\x1b[${tagColor(key)}m[${key}]\x1b[0m` : `[${key}]`;
      target.write(`${prefix} ${buffer}\n`);
    }
  });
}

function startProcess(service, state) {
  let child;
  try {
    child = spawn(pnpmCommand(), ["--filter", service.pkg, "dev"], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...service.env },
      stdio: ["ignore", "pipe", "pipe"],
      // 独立进程组：pnpm → tsx/next/taro 的子孙进程能被整组回收，不留孤儿。
      detached: !IS_WINDOWS,
      shell: IS_WINDOWS,
    });
  } catch (cause) {
    log(red(`${service.key} 启动失败：${cause instanceof Error ? cause.message : cause}`));
    state.status = "failed";
    state.detail = "启动失败";
    return null;
  }
  children.push({ child });
  pipePrefixed(child.stdout, service.key, process.stdout);
  pipePrefixed(child.stderr, service.key, process.stderr);
  child.once("error", (cause) => {
    log(red(`${service.key} 启动失败：${cause.message}`));
    state.status = "failed";
    state.detail = "启动失败";
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    if (state.status === "ready") {
      state.status = "stopped";
      log(red(`${service.key} 已退出（${signal ?? `code ${code}`}）`));
    } else if (state.status !== "failed") {
      state.status = "failed";
      state.detail = signal ? `信号 ${signal}` : `退出码 ${code}`;
      log(red(`${service.key} 启动过程中退出（${signal ?? `code ${code}`}），看上方日志`));
    }
  });
  return child;
}

function killGroup(child) {
  if (!child.pid) return;
  if (IS_WINDOWS) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* 已退出 */
    }
  }
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${reason}，正在停止 ${children.length} 个进程…`);
  for (const { child } of children) killGroup(child);
  // 给 tsx watch / next 一点时间自己收尾，然后对仍活着的进程组补 SIGKILL。
  await sleep(1200);
  if (!IS_WINDOWS) {
    for (const { child } of children) {
      if (child.exitCode === null && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
    }
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ 就绪探测 */
async function probe(service) {
  // Node 的 fetch 在部分环境只解析到 127.0.0.1，而服务可能只绑 ::1，所以逐个试。
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`http://${host}:${service.port}${service.healthPath}`, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "user-agent": "weave-dev-readiness" },
      });
      // 只要 <400 就算这个端在正常响应；307（登录重定向）对前端是健康态。
      if (response.status < 400) return response.status;
    } catch {
      /* 换下一个回环地址 */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function waitForReady(service, state, deadline) {
  while (!shuttingDown && Date.now() < deadline) {
    if (state.status === "failed" || state.status === "stopped") return;
    if (await isPortOpen(service.port)) {
      const status = await probe(service);
      if (status !== null) {
        state.status = "ready";
        state.httpStatus = status;
        const seconds = ((Date.now() - state.startedAt) / 1000).toFixed(1);
        log(`${green("✔")} ${service.key} 就绪（${seconds}s）${displayUrl(service)}`);
        return;
      }
    }
    await sleep(500);
  }
  if (state.status === "starting") {
    state.status = "failed";
    state.detail = "超时";
    log(red(`✘ ${service.key} 在 ${Math.round((deadline - state.startedAt) / 1000)}s 内未就绪`));
  }
}

/* ------------------------------------------------------------------ 主流程 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (cause) {
    console.error(`[dev] ${cause.message}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(
      [
        "pnpm dev [端...] [选项]",
        "",
        "端：" + SERVICES.map((service) => service.key).join(", "),
        "选项：",
        "  --no-infra     不自动启动 docker compose 的 postgres/redis",
        "  --no-migrate   不跑数据库迁移",
        "  --no-build     不构建共享包",
        "  --no-mobile    跳过 Taro watch 与移动端 H5 预览",
        "  --list         只打印计划启动的清单",
        "  --timeout=<s>  就绪等待上限（默认 180 秒）",
        "",
        "独立入口：pnpm dev:cli（交互式 CLI）、pnpm dev:desktop（Tauri 打印代理）",
      ].join("\n"),
    );
    return;
  }

  let services;
  try {
    services = selectServices(options);
  } catch (cause) {
    console.error(`[dev] ${cause.message}`);
    process.exit(2);
  }
  if (services.length === 0) {
    console.error("[dev] 没有选中任何端");
    process.exit(2);
  }

  if (options.list) {
    console.log(renderTable(services, new Map()));
    console.log(
      dim(
        `\n非 URL 端（独立入口）：${NON_URL_SERVICES.map((item) => `${item.key} → pnpm ${item.script}`).join("，")}`,
      ),
    );
    return;
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => void shutdown(signal));
  }

  try {
    assertToolchain();
  } catch (cause) {
    console.error(`[dev] ${cause.message}`);
    process.exit(2);
  }

  // 与 apps 的约定一致：有 .env 就吃进来（不覆盖已存在的环境变量）。
  const envFile = path.join(REPO_ROOT, ".env");
  if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(envFile);
      log("已加载 .env");
    } catch (cause) {
      log(yellow(`.env 解析失败，忽略：${cause instanceof Error ? cause.message : cause}`));
    }
  }

  const infra = await ensureInfra(options);

  if (options.build) {
    const built = runStep("构建共享包", pnpmCommand(), [
      "exec",
      "turbo",
      "run",
      "build",
      "--filter=./packages/*",
    ]);
    if (!built) {
      log(yellow("共享包构建失败；各端可能起不来，继续尝试"));
    }
  }

  if (options.migrate && infra === "local") {
    const migrated = runStep("迁移租户库", pnpmCommand(), ["db:migrate"]);
    if (migrated) runStep("迁移控制面库", pnpmCommand(), ["platform:migrate"]);
  } else if (options.migrate && infra === "remote") {
    log(yellow("外部数据库不自动迁移；需要时手动 pnpm db:migrate / pnpm platform:migrate"));
  } else if (options.migrate) {
    log(yellow("数据库不可达，跳过迁移"));
  }

  // 端口预检：先占位的旧进程会让「新起的端」假就绪，必须显式拒绝。
  const conflicts = [];
  for (const service of services) {
    if (await isPortOpen(service.port)) conflicts.push(service);
  }
  if (conflicts.length > 0) {
    for (const service of conflicts) {
      log(red(`端口 ${service.port} 已被占用（${service.key}），先停掉占用进程再重试`));
    }
    process.exit(1);
  }

  log(`启动 ${services.length} 个端…`);
  if (!services.some((service) => service.key === "mobile")) {
    log(dim("移动端 H5 已跳过（--no-mobile）"));
  }

  const states = new Map();
  const waiters = [];
  for (const service of services) {
    const state = { status: "starting", httpStatus: null, detail: "", startedAt: Date.now() };
    states.set(service.key, state);
    startProcess(service, state);
    waiters.push(waitForReady(service, state, Date.now() + options.timeoutMs));
  }

  await Promise.all(waiters);
  if (shuttingDown) return;

  const readyCount = services.filter(
    (service) => states.get(service.key).status === "ready",
  ).length;
  console.log("");
  console.log(renderTable(services, states));
  console.log(
    dim(
      `\n非 URL 端：${NON_URL_SERVICES.map((item) => `${item.key} → pnpm ${item.script}`).join("，")}`,
    ),
  );
  if (readyCount === services.length) {
    log(green(`全部 ${readyCount} 个端已就绪。Ctrl-C 停止全部进程。`));
  } else {
    log(
      yellow(
        `${readyCount}/${services.length} 个端就绪；未就绪的端看上方 [${services
          .filter((service) => states.get(service.key).status !== "ready")
          .map((service) => service.key)
          .join("] [")}] 日志与 health 端点。`,
      ),
    );
  }

  // 子进程全部退出且没有一个 ready：没有继续等待的意义，直接失败退出。
  if (readyCount === 0 && children.every(({ child }) => child.exitCode !== null)) {
    process.exit(1);
  }
  // 保持前台：dev 进程活着，日志和信号都由它转发。
  await new Promise(() => {});
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().catch((cause) => {
    console.error(`[dev] ${cause instanceof Error ? cause.stack : cause}`);
    process.exit(1);
  });
}
