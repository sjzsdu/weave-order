import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * CLI 的本地配置：服务器地址与个人 token。
 *
 * 位置（按优先级）：
 * 1. `WEAVE_CONFIG_DIR`（测试 / CI 用）
 * 2. `$XDG_CONFIG_HOME/weave-order`
 * 3. `~/.config/weave-order`
 *
 * 文件权限 0600、目录 0700：token 是明文凭据，只能本人可读。
 * 环境变量 `WEAVE_SERVER` / `WEAVE_TOKEN` 优先级高于配置文件，
 * 便于 codex 这类 agent 在不落盘的情况下被注入凭据。
 */

export interface CliConfig {
  serverUrl: string;
  token?: string;
  tokenPrefix?: string;
  email?: string;
  updatedAt?: string;
}

export const DEFAULT_SERVER = "http://localhost:3000";

export function configDir(): string {
  if (process.env.WEAVE_CONFIG_DIR) return process.env.WEAVE_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.trim() ? xdg : path.join(homedir(), ".config"), "weave-order");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function readConfig(): CliConfig {
  const file = configPath();
  if (!existsSync(file)) return { serverUrl: DEFAULT_SERVER };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CliConfig>;
    return {
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : DEFAULT_SERVER,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
      tokenPrefix: typeof parsed.tokenPrefix === "string" ? parsed.tokenPrefix : undefined,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return { serverUrl: DEFAULT_SERVER };
  }
}

export function writeConfig(config: CliConfig): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath();
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 语义有限；文件仍写在用户目录下。
  }
  return file;
}

export function clearConfig(): void {
  rmSync(configPath(), { force: true });
}

export function resolveServer(explicit?: string): string {
  return (
    explicit ??
    (process.env.WEAVE_SERVER && process.env.WEAVE_SERVER.trim()) ??
    readConfig().serverUrl ??
    DEFAULT_SERVER
  ).replace(/\/+$/, "");
}

/** 显式 --token > WEAVE_TOKEN > 配置文件。 */
export function resolveToken(explicit?: string): string | undefined {
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.env.WEAVE_TOKEN && process.env.WEAVE_TOKEN.trim()) {
    return process.env.WEAVE_TOKEN.trim();
  }
  return readConfig().token;
}
