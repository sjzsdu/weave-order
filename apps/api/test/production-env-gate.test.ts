import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddingProviderFromEnv,
  createImageEmbeddingProviderFromEnv,
} from "../src/platform/embedding";
import { loadEnv } from "../src/platform/env";
import { buildShareUrl, createShareToken } from "../src/kernel/share-token";

/**
 * 生产 env 组合的启动门禁（WAN-129）。
 *
 * 这不是「再写一遍 loadEnv 的 zod 断言」，而是把**启动期真正会执行的配置装配**
 * 串起来跑一遍：loadEnv → 图像 provider（main.ts eager） → 文本 provider。
 * 文本 provider 生产上要等首个请求装配内核时才创建，这里提前断言，
 * 让「配了真实 provider 却没 key」「维度写错」「provider 名拼错」更早暴露；
 * 文档 §9 会明确说明哪些错生产启动拦不住。
 *
 * 一条命令跑：
 *   pnpm --filter @weave-order/api verify:prod-env
 * CI 的 `pnpm test` 也会跑本文件，不需要额外 workflow。
 */

const RANDOM_SECRET = "a".repeat(64);

/** 生产必需的四个 HMAC secret + 真实的 S3 凭据（不是 dev 占位值）。 */
const productionBase = {
  NODE_ENV: "production",
  AUTH_MODE: "oidc",
  QUOTE_SHARE_SECRET: RANDOM_SECRET,
  PRINT_AGENT_SECRET: RANDOM_SECRET,
  PERSONAL_TOKEN_PEPPER: RANDOM_SECRET,
  ONBOARDING_SECRET: RANDOM_SECRET,
  S3_ACCESS_KEY_ID: "AKIDprod-not-the-dev-placeholder",
  S3_SECRET_ACCESS_KEY: "prod-secret-not-the-dev-placeholder",
  // 以下五项配错不会让进程起不来，只会让客户看到坏结果（WAN-130）：
  // 链接指向 localhost / 签名主机名错 / 通知不发 / 试用订阅不登记。
  PUBLIC_APP_URL: "https://quote.example.com",
  WEB_APP_URL: "https://app.example.com",
  S3_FORCE_PATH_STYLE: "false",
  PLATFORM_API_URL: "https://platform.example.com",
  NOTIFY_PROVIDER: "webhook",
  NOTIFY_WEBHOOK_URL: "https://notify.example.com/send",
} as const;

/** 假的租户/分享 id：只用于拼装链接，不碰数据库。 */
const FAKE_TENANT_ID = "11111111-1111-4111-8111-111111111111";
const FAKE_SHARE_ID = "22222222-2222-4222-8222-222222222222";

/**
 * 复刻 apps/api/src/main.ts 的启动顺序中与配置相关的部分：
 * 1. loadEnv 校验环境契约 + 生产门禁；
 * 2. 创建图像 embedding provider（bootstrap 里是 eager 的，起不来就不 listen）；
 * 3. 创建文本 embedding provider（内核装配时创建；这里提前到启动期断言）。
 */
function bootstrap(source: NodeJS.ProcessEnv) {
  const env = loadEnv(source);
  const image = createImageEmbeddingProviderFromEnv(env, source.DASHSCOPE_API_KEY);
  const text = createEmbeddingProviderFromEnv(env, source.DASHSCOPE_API_KEY);
  return { env, text, image };
}

/**
 * 把 runbook §4.1 的 dotenv 块读出来喂给 loadEnv，让「文档可直接复制」这件事
 * 由测试守住：谁改了块里的维度/开关却改错，这里会红。
 */
function readDocumentedEnv(): { raw: string; env: NodeJS.ProcessEnv } {
  // apps/api/test → 仓库根目录（api 以 CommonJS 编译，用 __dirname 而非 import.meta）。
  const docPath = path.resolve(__dirname, "../../../docs/media-production-checklist.md");
  const doc = readFileSync(docPath, "utf8");
  const section = doc.slice(doc.indexOf("### 4.1 生产值"));
  const block = /```dotenv\n([\s\S]*?)```/.exec(section);
  if (!block?.[1]) throw new Error("runbook §4.1 找不到 dotenv 代码块");
  const raw = block[1];
  return { raw, env: parseDotenv(fillPlaceholders(raw)) };
}

/** §4.1 里的占位符替换成合规的真实形态值；不依赖任何真实凭据。 */
function fillPlaceholders(raw: string): string {
  const replacements: Array<[string, string]> = [
    ["<openssl rand -hex 32>", RANDOM_SECRET],
    ["<APPID>", "1250000000"],
    ["<子账号 SecretId>", "AKIDprod-not-the-dev-placeholder"],
    ["<子账号 SecretKey>", "prod-secret-not-the-dev-placeholder"],
    ["<DashScope key；可与文本共用>", "sk-prod-dashscope"],
    ["<DashScope key>", "sk-prod-dashscope"],
    ["<轮换后的口令>", "prod-password"],
    ["<pg-host>", "pg.internal"],
    ["<quote-域名>", "quote.example.com"],
    ["<租户端域名>", "app.example.com"],
    ["<platform-api-domain>", "platform.internal"],
    ["<notify-gateway>", "notify.internal"],
    ["<你的域名>", "example.com"],
  ];
  let filled = raw;
  for (const [from, to] of replacements) filled = filled.split(from).join(to);
  return filled.replace(/<[^<>\n]+>/g, "placeholder");
}

function parseDotenv(block: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return env;
}

describe("生产 env 启动门禁（fail-fast）", () => {
  beforeEach(() => {
    // 本机/CI 可能导出了真实 key；不隔离会让「缺 key」用例变成假绿。
    vi.stubEnv("DASHSCOPE_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("正常生产组合可以启动：私有桶 + 签名 URL + 真实双 provider", () => {
    const { env, text, image } = bootstrap({
      ...productionBase,
      EMBEDDING_PROVIDER: "dashscope-text-v3",
      EMBEDDING_API_KEY: "sk-text-prod",
      IMAGE_EMBEDDING_PROVIDER: "dashscope-qwen3-vl",
      IMAGE_EMBEDDING_API_KEY: "sk-image-prod",
      IMAGE_EMBEDDING_DIMENSION: "1024",
      S3_ENDPOINT: "https://cos.ap-guangzhou.myqcloud.com",
      S3_REGION: "ap-guangzhou",
      S3_BUCKET: "weave-media-prod-1250000000",
      S3_FORCE_PATH_STYLE: "false",
    });
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(text.semantic).toBe(true);
    expect(image.semantic).toBe(true);
  });

  it("runbook §4.1 的整段 dotenv 可直接被 loadEnv 接受（文档即自证）", () => {
    const { raw, env } = readDocumentedEnv();
    const booted = bootstrap(env);
    // 生产默认是 true；文档必须显式写 false，否则会静默走 path-style。
    expect(raw).toMatch(/^S3_FORCE_PATH_STYLE=false$/m);
    expect(booted.env.S3_FORCE_PATH_STYLE).toBe(false);
    // 这两项漏配会静默回落 localhost，链接发给客户就是白屏。
    expect(new URL(booted.env.PUBLIC_APP_URL).hostname).not.toBe("localhost");
    expect(new URL(booted.env.WEB_APP_URL).hostname).not.toBe("localhost");
    expect(booted.text.semantic).toBe(true);
    expect(booted.image.semantic).toBe(true);
  });

  it("runbook §4.1 的 CDN 变体（打开 MEDIA_BASE_URL）也能启动", () => {
    const { env } = readDocumentedEnv();
    const cdnEnv = parseDotenv(
      fillPlaceholders(readDocumentedEnv().raw.replace(/^# MEDIA_BASE_URL=/m, "MEDIA_BASE_URL=")),
    );
    const booted = bootstrap(cdnEnv);
    expect(booted.env.MEDIA_BASE_URL).toBe("https://cdn.example.com");
    expect(env.MEDIA_BASE_URL).toBeUndefined();
  });

  it("缺 S3_ACCESS_KEY_ID（回落 dev 占位值）→ 拒绝启动", () => {
    const { S3_ACCESS_KEY_ID: _omit, ...withoutAccessKey } = productionBase;
    expect(() => bootstrap({ ...withoutAccessKey })).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it("生产使用 dev 占位对象存储凭据 → 拒绝启动", () => {
    expect(() =>
      bootstrap({
        ...productionBase,
        S3_ACCESS_KEY_ID: "weave-media",
        S3_SECRET_ACCESS_KEY: "weave-media-secret",
      }),
    ).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it("选了真实图像 provider 但没有 key → 拒绝启动", () => {
    expect(() =>
      bootstrap({
        ...productionBase,
        IMAGE_EMBEDDING_PROVIDER: "dashscope-qwen3-vl",
      }),
    ).toThrow(/IMAGE_EMBEDDING_API_KEY/);
  });

  it("图像向量维度不是该模型支持的维度 → 拒绝启动", () => {
    expect(() =>
      bootstrap({
        ...productionBase,
        IMAGE_EMBEDDING_PROVIDER: "dashscope-qwen3-vl",
        IMAGE_EMBEDDING_API_KEY: "sk-image-prod",
        IMAGE_EMBEDDING_DIMENSION: "999",
      }),
    ).toThrow(/IMAGE_EMBEDDING_DIMENSION/);
  });

  it("文本向量维度与 vector(1024) 不一致 → 拒绝启动", () => {
    expect(() =>
      bootstrap({
        ...productionBase,
        EMBEDDING_PROVIDER: "dashscope-text-v3",
        EMBEDDING_API_KEY: "sk-text-prod",
        EMBEDDING_DIMENSION: "512",
      }),
    ).toThrow(/EMBEDDING_DIMENSION/);
  });

  it("未知文本 provider（拼错名字）→ 拒绝启动，不静默回退 local-stub", () => {
    expect(() => bootstrap({ ...productionBase, EMBEDDING_PROVIDER: "text-embedding-v3" })).toThrow(
      /尚未接入/,
    );
  });

  it("未知图像 provider（拼错名字）→ 拒绝启动，不静默回退 local-stub", () => {
    expect(() =>
      bootstrap({ ...productionBase, IMAGE_EMBEDDING_PROVIDER: "qwen3-vl-embedding" }),
    ).toThrow(/尚未接入/);
  });

  it("CAPTION_FALLBACK=true 但文本仍是哈希 stub → 拒绝启动", () => {
    expect(() =>
      bootstrap({
        ...productionBase,
        CAPTION_FALLBACK: "true",
        IMAGE_EMBEDDING_API_KEY: "sk-image-prod",
        IMAGE_EMBEDDING_PROVIDER: "dashscope-qwen3-vl",
        EMBEDDING_PROVIDER: "local-stub",
      }),
    ).toThrow(/CAPTION_FALLBACK/);
  });

  it("可选变量写成空字符串（MEDIA_BASE_URL=）→ 拒绝启动；私有桶要把整行删掉", () => {
    expect(() => bootstrap({ ...productionBase, MEDIA_BASE_URL: "" })).toThrow(/MEDIA_BASE_URL/);
  });

  it("可选 key 写成空字符串（EMBEDDING_API_KEY=）→ 拒绝启动；local-stub 要整行删掉", () => {
    expect(() => bootstrap({ ...productionBase, EMBEDDING_API_KEY: "" })).toThrow(
      /EMBEDDING_API_KEY/,
    );
  });

  it("生产未设置 PUBLIC_APP_URL（回落 localhost:5174）→ 拒绝启动", () => {
    const { PUBLIC_APP_URL: _omit, ...withoutPublicUrl } = productionBase;
    expect(() => bootstrap(withoutPublicUrl)).toThrow(/PUBLIC_APP_URL/);
    expect(() =>
      bootstrap({ ...withoutPublicUrl, PUBLIC_APP_URL: "http://localhost:5174" }),
    ).toThrow(/PUBLIC_APP_URL/);
  });

  it("生产 PUBLIC_APP_URL 不是 https → 拒绝启动", () => {
    expect(() =>
      bootstrap({ ...productionBase, PUBLIC_APP_URL: "http://quote.example.com" }),
    ).toThrow(/PUBLIC_APP_URL/);
  });

  it("生产 PUBLIC_APP_URL=https://localhost:5174 → 回环判定独立生效，拒绝启动", () => {
    // 只靠 https 校验兜不住：写成 https://localhost 时协议合法、主机仍是本机。
    expect(() =>
      bootstrap({ ...productionBase, PUBLIC_APP_URL: "https://localhost:5174" }),
    ).toThrow(/PUBLIC_APP_URL/);
  });

  it("生产未设置 WEB_APP_URL（回落 localhost:3001）→ 拒绝启动", () => {
    const { WEB_APP_URL: _omit, ...withoutWebUrl } = productionBase;
    expect(() => bootstrap(withoutWebUrl)).toThrow(/WEB_APP_URL/);
    expect(() => bootstrap({ ...withoutWebUrl, WEB_APP_URL: "http://localhost:3001" })).toThrow(
      /WEB_APP_URL/,
    );
  });

  it("生产 WEB_APP_URL 不是 https → 拒绝启动", () => {
    expect(() => bootstrap({ ...productionBase, WEB_APP_URL: "http://app.example.com" })).toThrow(
      /WEB_APP_URL/,
    );
  });

  it("生产漏注入 S3_FORCE_PATH_STYLE（回落 true）→ 拒绝启动，不静默走 path-style", () => {
    const { S3_FORCE_PATH_STYLE: _omit, ...withoutPathStyle } = productionBase;
    expect(() => bootstrap(withoutPathStyle)).toThrow(/S3_FORCE_PATH_STYLE/);
    expect(() => bootstrap({ ...productionBase, S3_FORCE_PATH_STYLE: "true" })).toThrow(
      /S3_FORCE_PATH_STYLE/,
    );
  });

  it("生产未设置 PLATFORM_API_URL → 拒绝启动，不静默跳过试用订阅登记", () => {
    const { PLATFORM_API_URL: _omit, ...withoutPlatform } = productionBase;
    expect(() => bootstrap(withoutPlatform)).toThrow(/PLATFORM_API_URL/);
    expect(() =>
      bootstrap({ ...productionBase, PLATFORM_API_URL: "http://localhost:3002" }),
    ).toThrow(/PLATFORM_API_URL/);
  });

  it("生产 NOTIFY_PROVIDER 保持 log → 拒绝启动，通知不会静默丢弃", () => {
    const { NOTIFY_PROVIDER: _omit, ...withoutProvider } = productionBase;
    expect(() => bootstrap(withoutProvider)).toThrow(/NOTIFY_PROVIDER/);
    expect(() => bootstrap({ ...productionBase, NOTIFY_PROVIDER: "log" })).toThrow(
      /NOTIFY_PROVIDER/,
    );
  });

  it("生产 NOTIFY_PROVIDER=webhook 但缺 NOTIFY_WEBHOOK_URL → 拒绝启动", () => {
    const { NOTIFY_WEBHOOK_URL: _omit, ...withoutWebhook } = productionBase;
    expect(() => bootstrap(withoutWebhook)).toThrow(/NOTIFY_WEBHOOK_URL/);
  });

  it("生产配置生成一条报价分享链接：host 不是 localhost，且走正式域名", () => {
    const { env } = bootstrap(productionBase);
    const { token } = createShareToken(
      { t: FAKE_TENANT_ID, s: FAKE_SHARE_ID },
      env.QUOTE_SHARE_SECRET,
    );
    const url = buildShareUrl(env.PUBLIC_APP_URL, token);
    const parsed = new URL(url);
    expect(parsed.hostname).not.toBe("localhost");
    expect(parsed.hostname).not.toBe("127.0.0.1");
    expect(parsed.origin).toBe("https://quote.example.com");
    expect(parsed.pathname.startsWith("/s/")).toBe(true);
  });

  it("本地默认组合仍可零 key 启动（不误伤开发体验）", () => {
    const { env, text, image } = bootstrap({ NODE_ENV: "development", AUTH_MODE: "dev" });
    expect(env.S3_ACCESS_KEY_ID).toBe("weave-media");
    expect(text.semantic).toBe(false);
    expect(image.semantic).toBe(false);
  });

  it.each([
    ["QUOTE_SHARE_SECRET"],
    ["PRINT_AGENT_SECRET"],
    ["PERSONAL_TOKEN_PEPPER"],
    ["ONBOARDING_SECRET"],
  ])("四个 HMAC secret 回落 dev 占位值 → 拒绝启动：%s", (key) => {
    const partial: NodeJS.ProcessEnv = { ...productionBase };
    delete partial[key];
    expect(() => bootstrap(partial)).toThrow(new RegExp(key));
  });
});
