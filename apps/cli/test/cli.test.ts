import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";
import { ApiError, createClient, exitCodeFor, NetworkError, request } from "../src/api";
import {
  clearConfig,
  configPath,
  readConfig,
  resolveServer,
  resolveToken,
  writeConfig,
} from "../src/config";
import { installSkill, resolveSkillTarget, skillSourcePath } from "../src/skill";

let tempDir = "";

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "weave-cli-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("参数解析", () => {
  it("区分位置参数、字符串参数与布尔参数", () => {
    const args = parseArgs(["token", "create", "笔记本", "--scope", "read,write", "--json"]);
    expect(args.command).toEqual(["token", "create", "笔记本"]);
    expect(args.flags.get("scope")).toBe("read,write");
    expect(args.json).toBe(true);
  });

  it("支持 --flag=value 与 `--` 透传", () => {
    const args = parseArgs(["tool", "generate-quote-draft", "--payload={}", "--", "--json"]);
    expect(args.flags.get("payload")).toBe("{}");
    expect(args.command).toEqual(["tool", "generate-quote-draft", "--json"]);
    expect(args.json).toBe(false);
  });

  it("布尔参数不吞掉下一个位置参数", () => {
    const args = parseArgs(["approve", "--yes", "abc", "--kind", "quote"]);
    expect(args.flags.get("yes")).toBe(true);
    expect(args.command).toEqual(["approve", "abc"]);
    expect(args.flags.get("kind")).toBe("quote");
  });
});

describe("本地配置", () => {
  it("写入 0600 文件，读回一致，并可用环境变量覆盖服务器", () => {
    process.env.WEAVE_CONFIG_DIR = tempDir;
    const file = writeConfig({
      serverUrl: "https://weave.example.com",
      token: "wo_abcdefghij_" + "b".repeat(32),
      tokenPrefix: "wo_abcdefghij",
      email: "a@b.test",
    });
    expect(file).toBe(configPath());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readConfig().email).toBe("a@b.test");

    expect(resolveServer()).toBe("https://weave.example.com");
    process.env.WEAVE_SERVER = "http://127.0.0.1:9999";
    expect(resolveServer()).toBe("http://127.0.0.1:9999");
    delete process.env.WEAVE_SERVER;

    process.env.WEAVE_TOKEN = "wo_env";
    expect(resolveToken()).toBe("wo_env");
    delete process.env.WEAVE_TOKEN;
    expect(resolveToken()).toContain("wo_abcdefghij_");

    clearConfig();
    expect(readConfig().serverUrl).toBe("http://localhost:3000");
    delete process.env.WEAVE_CONFIG_DIR;
  });
});

describe("API 客户端错误语义", () => {
  let baseUrl = "";
  const server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/forbidden") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "SCOPE_REQUIRED", message: "缺少 approve 作用域" } }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("成功时返回解析后的 JSON", async () => {
    const client = createClient({ serverUrl: baseUrl });
    await expect(client.get<{ ok: boolean }>("/ok")).resolves.toEqual({ ok: true });
  });

  it("服务端错误保留 code / status，并映射为退出码 3", async () => {
    try {
      await request({ serverUrl: baseUrl }, "GET", "/forbidden");
      throw new Error("应当失败");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.code).toBe("SCOPE_REQUIRED");
      expect(apiError.status).toBe(403);
      expect(exitCodeFor(apiError)).toBe(3);
    }
  });

  it("连接失败转成可执行的 NetworkError，退出码 4", async () => {
    try {
      await request({ serverUrl: "http://127.0.0.1:1" }, "GET", "/ok");
      throw new Error("应当失败");
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as Error).message).toContain("WEAVE_SERVER");
      expect(exitCodeFor(error)).toBe(4);
    }
  });
});

describe("agent skill 安装", () => {
  it("仓库里有 canonical SKILL.md，且带 frontmatter", () => {
    const source = skillSourcePath();
    const content = readFileSync(source, "utf8");
    expect(content.startsWith("---")).toBe(true);
    expect(content).toContain("name: weave-order");
    expect(content).toContain("weave doctor");
  });

  it("安装到指定目录，重复安装幂等，内容不同时不覆盖", () => {
    const target = { name: "custom", dir: path.join(tempDir, "skills", "weave-order") };
    const first = installSkill(target);
    expect(first.changed).toBe(true);
    expect(readFileSync(first.file, "utf8")).toContain("name: weave-order");

    const second = installSkill(target);
    expect(second.changed).toBe(false);

    writeFileSync(first.file, "本地改过的内容");
    expect(() => installSkill(target)).toThrow(/--force/);
    expect(installSkill(target, { force: true }).changed).toBe(true);
  });

  it("目标路径按 codex / claude 约定解析", () => {
    expect(resolveSkillTarget("codex", undefined).dir).toContain(path.join(".codex", "skills"));
    expect(resolveSkillTarget("claude", undefined).dir).toContain(path.join(".claude", "skills"));
    expect(() => resolveSkillTarget("unknown-agent", undefined)).toThrow(/未知的 skill 目标/);
  });
});
