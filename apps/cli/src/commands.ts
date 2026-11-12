import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { ApiError, createClient, EXIT, NetworkError } from "./api";
import type {
  ApiClient,
  ApiTokenView,
  DevicePollView,
  DeviceStartView,
  IdentityView,
  ToolResultView,
} from "./api";
import { flagBool, flagNumber, flagString } from "./args";
import type { ParsedArgs } from "./args";
import { clearConfig, readConfig, resolveServer, resolveToken, writeConfig } from "./config";
import { printJson, printLine, printTable, shortTime } from "./output";
import { installSkill, readSkill, resolveSkillTarget } from "./skill";

export const CLI_VERSION = "0.1.0";
const CLIENT_NAME = `weave-cli/${CLI_VERSION}`;

export interface CliContext {
  json: boolean;
  /** 显式 --server 优先；否则 WEAVE_SERVER / 配置文件。 */
  serverFlag?: string;
}

function clientFor(ctx: CliContext, withToken = true): ApiClient {
  return createClient({
    serverUrl: resolveServer(ctx.serverFlag),
    token: withToken ? resolveToken() : undefined,
  });
}

/** 没有凭据时给出可执行提示，而不是 401 原文。 */
function requireTokenHint(): never {
  throw new ApiError("AUTH_REQUIRED", "尚未登录：请先执行 weave login（或设置 WEAVE_TOKEN）", 401);
}

function openBrowser(url: string): boolean {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `weave login`：设备码流程（默认）或直接导入已有 token（--token）。 */
export async function login(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const serverUrl = resolveServer(ctx.serverFlag);
  const providedToken = flagString(args, "token");

  if (providedToken) {
    const client = createClient({ serverUrl, token: providedToken });
    const identity = await client.get<IdentityView>("/api/auth/me");
    writeConfig({
      serverUrl,
      token: providedToken,
      tokenPrefix: identity.token.prefix,
      email: identity.user.email,
      updatedAt: new Date().toISOString(),
    });
    if (ctx.json) {
      printJson({ ok: true, serverUrl, user: identity.user, token: identity.token });
    } else {
      printLine(`✔ 已登录 ${identity.user.email}（${identity.token.prefix}）→ ${serverUrl}`);
    }
    return EXIT.OK;
  }

  const client = createClient({ serverUrl });
  const start = await client.post<DeviceStartView>("/api/auth/device/start", {
    clientName: CLIENT_NAME,
  });

  if (ctx.json) {
    printJson({
      status: "awaiting_approval",
      serverUrl,
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      verificationUriComplete: start.verificationUriComplete,
      expiresIn: start.expiresIn,
    });
  } else {
    printLine(`正在登录 ${serverUrl}`);
    printLine("");
    printLine(`  确认码：${start.userCode}`);
    printLine(`  在浏览器打开：${start.verificationUriComplete}`);
    printLine("");
    printLine(`等待你在浏览器确认（${Math.round(start.expiresIn / 60)} 分钟内有效）…`);
  }

  if (!flagBool(args, "no-browser")) {
    openBrowser(start.verificationUriComplete);
  }

  const deadline = Date.now() + start.expiresIn * 1000;
  let interval = start.interval;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    let result: DevicePollView;
    try {
      result = await client.post<DevicePollView>("/api/auth/device/poll", {
        deviceCode: start.deviceCode,
      });
    } catch (error) {
      // 网络抖动不应该让整个登录失败，继续等到超时。
      if (error instanceof NetworkError) continue;
      throw error;
    }

    if (result.status === "pending") continue;
    if (result.status === "slow_down") {
      interval = result.interval;
      continue;
    }
    if (result.status === "approved") {
      writeConfig({
        serverUrl,
        token: result.token,
        tokenPrefix: result.tokenView.prefix,
        email: result.user.email,
        updatedAt: new Date().toISOString(),
      });
      if (ctx.json) {
        printJson({
          ok: true,
          serverUrl,
          user: result.user,
          token: result.tokenView,
        });
      } else {
        printLine("");
        printLine(`✔ 已登录 ${result.user.email}（${result.tokenView.prefix}）`);
        printLine(`  凭据已保存到 ${writeConfigPathHint()}`);
      }
      return EXIT.OK;
    }
    if (result.status === "denied") {
      if (ctx.json) printJson({ ok: false, status: "denied" });
      else printLine("✖ 登录被拒绝，CLI 没有获得任何凭据。");
      return EXIT.ERROR;
    }
    if (result.status === "expired") {
      if (ctx.json) printJson({ ok: false, status: "expired" });
      else printLine("✖ 登录超时，请重新执行 weave login。");
      return EXIT.ERROR;
    }
  }

  if (ctx.json) printJson({ ok: false, status: "expired" });
  else printLine("✖ 登录超时，请重新执行 weave login。");
  return EXIT.ERROR;
}

function writeConfigPathHint(): string {
  return process.env.WEAVE_CONFIG_DIR
    ? `${process.env.WEAVE_CONFIG_DIR}/config.json`
    : "~/.config/weave-order/config.json";
}

export function logout(ctx: CliContext): number {
  const config = readConfig();
  clearConfig();
  if (ctx.json) printJson({ ok: true, cleared: true });
  else printLine(`✔ 已清除本地凭据${config.email ? `（${config.email}）` : ""}`);
  return EXIT.OK;
}

export async function whoami(ctx: CliContext): Promise<number> {
  if (!resolveToken()) requireTokenHint();
  const identity = await clientFor(ctx).get<IdentityView>("/api/auth/me");
  if (ctx.json) {
    printJson(identity);
    return EXIT.OK;
  }
  printLine(`账号：${identity.user.name} <${identity.user.email}>`);
  printLine(`凭据：${identity.token.prefix}（${identity.token.name}）`);
  printLine(`作用域：${identity.token.scopes.join(", ")}`);
  printLine(`状态：${identity.token.status}`);
  printLine(`最近使用：${shortTime(identity.token.lastUsedAt)}`);
  return EXIT.OK;
}

export async function tokenCommand(
  args: ParsedArgs,
  sub: string | undefined,
  ctx: CliContext,
): Promise<number> {
  const client = clientFor(ctx);
  if (!resolveToken()) requireTokenHint();

  if (sub === "list" || sub === undefined) {
    const result = await client.get<{ tokens: ApiTokenView[] }>("/api/auth/tokens");
    if (ctx.json) {
      printJson(result);
      return EXIT.OK;
    }
    const includeRevoked = flagBool(args, "include-revoked");
    printTable(
      result.tokens.filter((token) => includeRevoked || token.status === "ACTIVE"),
      [
        { header: "ID", value: (token) => token.id },
        { header: "名称", value: (token) => token.name },
        { header: "前缀", value: (token) => token.prefix },
        { header: "作用域", value: (token) => token.scopes.join(",") },
        { header: "状态", value: (token) => token.status },
        { header: "创建", value: (token) => shortTime(token.createdAt) },
        { header: "最近使用", value: (token) => shortTime(token.lastUsedAt) },
      ],
    );
    return EXIT.OK;
  }

  if (sub === "create") {
    const name = args.command[2] ?? flagString(args, "name");
    if (!name) {
      throw new ApiError(
        "USAGE",
        "用法：weave token create <名称> [--scope read,write] [--days 90]",
        400,
      );
    }
    const scopeRaw = flagString(args, "scope") ?? "read,write";
    const scopes = scopeRaw
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const created = await client.post<{ token: string; tokenView: ApiTokenView }>(
      "/api/auth/tokens",
      {
        name,
        scopes,
        expiresInDays: flagNumber(args, "days"),
      },
    );
    if (ctx.json) {
      printJson(created);
      return EXIT.OK;
    }
    printLine("✔ 已签发凭据（明文只显示这一次，请立即保存）：");
    printLine("");
    printLine(`  ${created.token}`);
    printLine("");
    printLine(`  名称：${created.tokenView.name}`);
    printLine(`  作用域：${created.tokenView.scopes.join(", ")}`);
    printLine(`  前缀：${created.tokenView.prefix}`);
    return EXIT.OK;
  }

  if (sub === "revoke") {
    const target = args.command[2];
    if (!target) throw new ApiError("USAGE", "用法：weave token revoke <token-id 或前缀>", 400);
    const tokens = await client.get<{ tokens: ApiTokenView[] }>("/api/auth/tokens");
    const match =
      tokens.tokens.find((token) => token.id === target) ??
      tokens.tokens.find((token) => token.prefix === target) ??
      tokens.tokens.find((token) => token.id.startsWith(target));
    if (!match) throw new ApiError("RESOURCE_NOT_FOUND", `找不到凭据：${target}`, 404);
    const revoked = await client.del<ApiTokenView>(`/api/auth/tokens/${match.id}`);
    if (ctx.json) {
      printJson(revoked);
      return EXIT.OK;
    }
    printLine(`✔ 已撤销 ${revoked.prefix}（${revoked.name}），立即失效。`);
    return EXIT.OK;
  }

  throw new ApiError("USAGE", `未知子命令：token ${sub ?? ""}`, 400);
}

interface CustomerRow {
  id: string;
  code: string;
  name: string;
  tier: string;
  contactName: string | null;
}

interface SampleRow {
  id: string;
  code: string;
  name: string;
  composition: string | null;
  weight?: string | null;
}

export async function dataCommand(
  command: string,
  args: ParsedArgs,
  ctx: CliContext,
): Promise<number> {
  const client = clientFor(ctx);
  const limit = flagNumber(args, "limit");

  switch (command) {
    case "customers": {
      const result = await client.get<{ customers: CustomerRow[] }>(
        `/api/customers${limit ? `?limit=${limit}` : ""}`,
      );
      if (ctx.json) return (printJson(result), EXIT.OK);
      printTable(result.customers, [
        { header: "ID", value: (row) => row.id },
        { header: "编号", value: (row) => row.code },
        { header: "客户", value: (row) => row.name },
        { header: "等级", value: (row) => row.tier },
        { header: "联系人", value: (row) => row.contactName ?? "-" },
      ]);
      return EXIT.OK;
    }
    case "samples": {
      const result = await client.get<{ samples: SampleRow[] }>(
        `/api/samples${limit ? `?limit=${limit}` : ""}`,
      );
      if (ctx.json) return (printJson(result), EXIT.OK);
      printTable(result.samples, [
        { header: "ID", value: (row) => row.id },
        { header: "编号", value: (row) => row.code },
        { header: "品名", value: (row) => row.name },
        { header: "成分", value: (row) => row.composition ?? "-" },
      ]);
      return EXIT.OK;
    }
    case "approvals": {
      const result = await client.get<{ items: unknown[] }>("/api/approvals");
      if (ctx.json) return (printJson(result), EXIT.OK);
      printJson(result);
      return EXIT.OK;
    }
    case "panorama": {
      const result = await client.get<unknown>("/api/panorama");
      printJson(result);
      return EXIT.OK;
    }
    case "audit": {
      const result = await client.get<{ entries: unknown[] }>(
        `/api/audit${limit ? `?limit=${limit}` : ""}`,
      );
      printJson(result);
      return EXIT.OK;
    }
    default:
      throw new ApiError("USAGE", `未知命令：${command}`, 400);
  }
}

export async function decideCommand(
  decision: "APPROVE" | "REJECT",
  args: ParsedArgs,
  ctx: CliContext,
): Promise<number> {
  const id = args.command[1];
  const kind = flagString(args, "kind");
  if (!id || (kind !== "quote" && kind !== "sample_shipment")) {
    throw new ApiError(
      "USAGE",
      `用法：weave ${decision === "APPROVE" ? "approve" : "reject"} <id> --kind quote|sample_shipment [--note "..."]`,
      400,
    );
  }
  const result = await clientFor(ctx).post<unknown>("/api/approvals/decide", {
    id,
    kind,
    decision,
    note: flagString(args, "note"),
  });
  if (ctx.json) return (printJson(result), EXIT.OK);
  printJson(result);
  return EXIT.OK;
}

const TOOL_PATHS: Record<string, string> = {
  "search-by-spec": "/api/tools/search-by-spec",
  "search-by-image": "/api/tools/search-by-image",
  "get-customer-history": "/api/tools/get-customer-history",
  "generate-quote-draft": "/api/tools/generate-quote-draft",
  "create-sample-shipment": "/api/tools/create-sample-shipment",
};

function buildToolPayload(tool: string, args: ParsedArgs): unknown {
  const raw = flagString(args, "payload");
  if (raw !== undefined) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new ApiError(
        "INVALID_INPUT",
        `--payload 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        400,
      );
    }
  }

  switch (tool) {
    case "search-by-spec": {
      const query = flagString(args, "query") ?? args.command[2];
      if (!query)
        throw new ApiError("USAGE", '用法：weave tool search-by-spec --query "棉 平纹"', 400);
      return {
        query,
        composition: flagString(args, "composition"),
        limit: flagNumber(args, "limit"),
      };
    }
    case "search-by-image": {
      const file = flagString(args, "file");
      if (!file)
        throw new ApiError("USAGE", "用法：weave tool search-by-image --file ./fabric.jpg", 400);
      const base64 = readFileSync(file).toString("base64");
      const ext = file.toLowerCase().split(".").pop();
      const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      return {
        image: { mimeType, base64 },
        topK: flagNumber(args, "top-k"),
        minSimilarity: flagNumber(args, "min-similarity"),
      };
    }
    case "get-customer-history": {
      const customerId = flagString(args, "customer-id") ?? args.command[2];
      if (!customerId) {
        throw new ApiError(
          "USAGE",
          "用法：weave tool get-customer-history --customer-id <uuid>",
          400,
        );
      }
      return { customerId, limit: flagNumber(args, "limit") };
    }
    default:
      throw new ApiError(
        "USAGE",
        `${tool} 需要 --payload '<json>'（该工具入参较多，避免命令行歧义）`,
        400,
      );
  }
}

export async function toolCommand(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const tool = args.command[1];
  if (!tool) {
    if (ctx.json) {
      printJson({ tools: Object.keys(TOOL_PATHS) });
      return EXIT.OK;
    }
    printLine("可用工具：");
    for (const name of Object.keys(TOOL_PATHS)) printLine(`  ${name}`);
    return EXIT.OK;
  }
  const path = TOOL_PATHS[tool];
  if (!path) {
    throw new ApiError(
      "USAGE",
      `未知工具：${tool}。可用：${Object.keys(TOOL_PATHS).join(", ")}`,
      400,
    );
  }
  const payload = buildToolPayload(tool, args);
  const result = await clientFor(ctx).post<ToolResultView>(path, payload);
  if (ctx.json) {
    printJson(result);
  } else if (result.ok) {
    printJson(result.data);
  } else {
    printJson(result.error);
  }
  return result.ok ? EXIT.OK : EXIT.ERROR;
}

export async function doctor(ctx: CliContext): Promise<number> {
  const serverUrl = resolveServer(ctx.serverFlag);
  const token = resolveToken();
  const report: Record<string, unknown> = { serverUrl, hasToken: Boolean(token) };

  try {
    const client = createClient({ serverUrl });
    report.health = await client.get<{ ok: boolean; database: string }>("/api/health");
  } catch (error) {
    report.health = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (token) {
    try {
      const identity = await createClient({ serverUrl, token }).get<IdentityView>("/api/auth/me");
      report.identity = {
        email: identity.user.email,
        token: identity.token.prefix,
        scopes: identity.token.scopes,
      };
    } catch (error) {
      report.identity = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (ctx.json) {
    printJson(report);
  } else {
    printLine(`服务地址：${serverUrl}`);
    printLine(`凭据：${token ? "已配置" : "未配置（weave login）"}`);
    printLine(`健康检查：${JSON.stringify(report.health)}`);
    if (report.identity) printLine(`身份：${JSON.stringify(report.identity)}`);
  }
  return report.health && (report.health as { ok?: boolean }).ok ? EXIT.OK : EXIT.ERROR;
}

export function skillCommand(args: ParsedArgs, sub: string | undefined, ctx: CliContext): number {
  if (sub === "print" || sub === undefined) {
    const skill = readSkill();
    if (ctx.json) printJson(skill);
    else process.stdout.write(skill.content);
    return EXIT.OK;
  }
  if (sub === "install") {
    const target = resolveSkillTarget(flagString(args, "target"), flagString(args, "dir"));
    const result = installSkill(target, { force: flagBool(args, "force") });
    if (ctx.json) {
      printJson({ ok: true, target: target.name, ...result });
      return EXIT.OK;
    }
    printLine(
      result.changed
        ? `✔ 已安装 weave-order skill → ${result.file}`
        : `✔ skill 已是最新 → ${result.file}`,
    );
    printLine(`  来源：${result.source}`);
    printLine("  重启对应的 agent（codex 等）后即可加载。");
    return EXIT.OK;
  }
  throw new ApiError(
    "USAGE",
    "用法：weave skill print | weave skill install [--target codex|claude|generic] [--dir DIR] [--force]",
    400,
  );
}
