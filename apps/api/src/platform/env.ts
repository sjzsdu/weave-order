import { z } from "zod";
import { DASHSCOPE_MULTIMODAL_DIMENSIONS } from "./embedding";
import { isProductionLike } from "./runtime-mode";

/** 仅本地/测试使用的占位密钥；生产出现即 fail-fast（与 database-guard 同一策略）。 */
export const DEV_QUOTE_SHARE_SECRET = "dev-only-quote-share-secret-change-me-0001";
/** 打印代理 token 的本地占位密钥；生产必须覆盖。 */
export const DEV_PRINT_AGENT_SECRET = "dev-only-print-agent-secret-change-me-0001";
/** 个人访问凭据（PAT）哈希的本地占位密钥；生产必须覆盖。 */
export const DEV_PERSONAL_TOKEN_PEPPER = "dev-only-personal-token-pepper-change-me-0001";
/** 开通链接（onboarding ticket）的本地占位密钥；生产必须覆盖，且与平台侧一致。 */
export const DEV_ONBOARDING_SECRET = "dev-only-onboarding-secret-change-me-0001";

/** 仅本地/测试使用的网关占位 key；生产 + openai-compatible provider 时拒绝启动。 */
export const DEV_LLM_API_KEY = "sk-local-dev";

/** 明显的占位凭据：生产态出现任意一个都视为未配置（fail closed）。 */
export function isPlaceholderLlmKey(value: string): boolean {
  const key = value.trim();
  return (
    key.length === 0 ||
    key === DEV_LLM_API_KEY ||
    /^<.*>$/.test(key) ||
    /^(?:change[-_]?me|your[-_]?(?:api[-_]?)?key|sk[-_]?xxx+)$/i.test(key)
  );
}

/** `LLM_MODEL_ALLOWLIST` 的逗号分隔解析；空值/空白项一律忽略。 */
export function parseModelAllowlist(value: string | undefined): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

/**
 * 本地 MinIO 的占位凭据（docker-compose.yml 同值）；生产出现即拒绝启动。
 * 对象存储里放的是客户面料图，公开默认凭据等于把整桶图片交出去。
 */
export const DEV_S3_ACCESS_KEY_ID = "weave-media";
export const DEV_S3_SECRET_ACCESS_KEY = "weave-media-secret";

/** 环境变量里的布尔值：只认 1/true/yes/on，"false" 不会被当成 true。 */
function booleanEnv(fallback: boolean) {
  return z
    .preprocess((value) => {
      if (value === undefined || value === "") return fallback;
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string") {
        return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
      }
      return fallback;
    }, z.boolean())
    .default(fallback);
}

/**
 * 运行时环境变量契约。
 * 默认值与 docker-compose.yml 一致，因此本地 `docker compose up` 后
 * 不需要 .env 也能跑通；线上用环境变量覆盖。
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://weave:weave@localhost:5433/weave_order"),
  /** 网关业务连接：生产必须是 weave_app（无 BYPASSRLS）；本地缺省沿用 DATABASE_URL。 */
  APP_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default("redis://localhost:6380"),
  /**
   * embedding provider：local-stub（默认，无需外部 key，但**不携带语义**）或
   * dashscope-text-v3（通义真实语义向量，需要 key）。
   */
  EMBEDDING_PROVIDER: z.string().min(1).default("local-stub"),
  /** 真实 provider 的模型名；local-stub 忽略。 */
  EMBEDDING_MODEL: z.string().min(1).default("text-embedding-v3"),
  /** 向量维度；pgvector 列固定 1024，改维度必须同时改迁移。 */
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(1024),
  /** OpenAI 兼容 embedding 端点（默认直连通义；换成网关时只改这里）。 */
  EMBEDDING_BASE_URL: z.string().url().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  /** embedding key；缺省回落到 DASHSCOPE_API_KEY。 */
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  /** 单次 embedding 请求超时（毫秒）。 */
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** embedding 失败重试的总尝试次数（指数退避）。 */
  EMBEDDING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /** 语义检索的最低 cosine 相似度；低于它的结果不返回（不做归一化凑数）。 */
  /** 实测：无关文本的 cosine 基线约 0.37–0.49，0.5 能挡住绝大部分噪声。 */
  SEARCH_SEMANTIC_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),
  // ---- 图像向量（S4：以图找样）----
  /**
   * 图像 embedding provider：local-stub（默认，无 key，**不携带视觉语义**）或
   * dashscope-qwen3-vl（通义多模态真实向量）。
   */
  IMAGE_EMBEDDING_PROVIDER: z.string().min(1).default("local-stub"),
  /** 多模态模型名；与文本 provider 独立，别拿文本模型顶图向量。 */
  IMAGE_EMBEDDING_MODEL: z.string().min(1).default("qwen3-vl-embedding"),
  /** 向量维度。列不定维，换维度只需新建同维度的 partial HNSW 索引。 */
  IMAGE_EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(1024),
  /** DashScope 原生多模态端点（不是 OpenAI 兼容端点）。 */
  IMAGE_EMBEDDING_BASE_URL: z.string().url().default("https://dashscope.aliyuncs.com/api/v1"),
  /** 图像 embedding key；缺省回落到 DASHSCOPE_API_KEY。 */
  IMAGE_EMBEDDING_API_KEY: z.string().min(1).optional(),
  IMAGE_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  IMAGE_EMBEDDING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /**
   * 送模型前把图缩到长边多少像素（0 = 不缩）。
   * 实测 512px 与 1024px 分离度差 0.006（噪声内），而 token 从 1024 降到 256、成本降 4 倍。
   */
  IMAGE_EMBEDDING_MAX_EDGE: z.coerce.number().int().min(0).max(2048).default(512),
  /**
   * 图-图检索的最低余弦相似度。
   * 实测（qwen3-vl-embedding）：同款异角度 0.89~0.96，最易混异款 0.61~0.69，
   * 0.75 能把异款挡住；0.55 会把「浅蓝牛仔 vs 灰针织」当成同款。
   */
  SEARCH_IMAGE_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.75),
  /**
   * 文-图检索的最低余弦相似度。图-图与文-图不是同一分布
   * （实测文-图正确配对 0.35~0.57，其余 ≤0.34），所以阈值必须分开配。
   */
  SEARCH_IMAGE_TEXT_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.35),
  /**
   * 图向量服务不可用时的兜底：视觉模型生成中文描述 → 走文本语义检索。
   * 默认关：宁可明确报错，也不要静默换一条质量不同的链路。
   */
  CAPTION_FALLBACK: booleanEnv(false),
  /** caption 用的视觉模型（OpenAI 兼容 chat/completions）。 */
  CAPTION_MODEL: z.string().min(1).default("qwen3-vl-plus"),
  CAPTION_BASE_URL: z.string().url().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  /** 智能体 LLM provider：local-rule（默认，确定性规则，无需 key）或 openai-compatible。 */
  LLM_PROVIDER: z.enum(["local-rule", "openai-compatible"]).default("local-rule"),
  /**
   * 通用 OpenAI 兼容企业网关地址（含 /v1，**代码不设生产默认值**）。
   * 本地开发地址只放源码仓库的 .env；生产地址只放部署仓库 weave-order/.env。
   */
  LLM_BASE_URL: z.string().url().optional(),
  /** 网关令牌；只存环境变量，不写库、不落日志。 */
  LLM_API_KEY: z.string().min(1).optional(),
  /** 单次调用超时（毫秒）。 */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** 未保存数据库设置时的模型 fallback / seed 来源（不指定任何厂商固定值）。 */
  LLM_DEFAULT_MODEL: z.string().min(1).optional(),
  LLM_REASONING_MODEL: z.string().min(1).optional(),
  LLM_VISION_MODEL: z.string().min(1).optional(),
  /** 逗号分隔的模型白名单；未配置时为空，调用模型前必须显式配置。 */
  LLM_MODEL_ALLOWLIST: z.string().optional(),
  /** 物流 provider：local-deterministic（默认，本地确定性） */
  LOGISTICS_PROVIDER: z.string().min(1).default("local-deterministic"),
  /** 客户回复来源：local-scripted（默认，便于演示与测试） */
  REPLY_SOURCE: z.string().min(1).default("local-scripted"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * 部署形态（dev / test / production），与 `NODE_ENV` 分开：
   * 测试环境必须与生产同构（`NODE_ENV=production + AUTH_MODE=oidc`），
   * 只有它能把 `demo:reset` 与剧本接口标记为「可重置」。
   */
  WEAVE_ENV: z.enum(["dev", "test", "production"]).optional(),
  /**
   * 启动即断言数据库结构与镜像一致：缺表则拒绝启动（部署失败），而不是让单个功能
   * 在运行时 500。仅在 compose 把 migrate 排在 api 之前时打开，否则会把
   * 「一个功能坏」放大成「整站起不来」。
   */
  WEAVE_REQUIRE_SCHEMA_AT_BOOT: booleanEnv(false),
  /** dev：接受 `Bearer dev:<sub>:<org>`（仅本地）；oidc：Casdoor JWKS 验签。 */
  AUTH_MODE: z.enum(["dev", "oidc"]).default("dev"),
  /**
   * 租户会话存储：auto（dev 用进程内，其余用 Redis）/ redis / memory。
   * 多实例部署必须用 redis，否则同一个人会被不同实例随机判为未登录。
   */
  SESSION_STORE: z.enum(["auto", "redis", "memory"]).default("auto"),
  /** 会话 TTL（秒，滑动续期）；默认 7 天。 */
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  CASDOOR_ISSUER: z.string().url().default("https://sso.wnbgj.com"),
  CASDOOR_AUDIENCE: z.string().min(1).default("weave-order"),
  CASDOOR_JWKS_URI: z.string().url().optional(),
  /** 客户报价分享链接的站点根地址。 */
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5174"),
  /** 客户报价链接的 HMAC 密钥；生产必须覆盖为 ≥32 字节随机值。 */
  QUOTE_SHARE_SECRET: z.string().min(32).default(DEV_QUOTE_SHARE_SECRET),
  /** 平台控制面签发的开通链接密钥；必须与 apps/platform-api 的 ONBOARDING_SECRET 相同。 */
  ONBOARDING_SECRET: z.string().min(32).default(DEV_ONBOARDING_SECRET),
  /** T-001 imageUrl 变体允许取图的对象存储 / CDN 域名（逗号分隔）。 */
  MEDIA_ALLOWED_HOSTS: z.string().default(""),
  /** 单张图片上限（上传与按 URL 取图共用；默认 10MB）。 */
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().max(10_485_760).default(10_485_760),
  // ---- 对象存储（S3 兼容：本地 MinIO / 生产腾讯云 COS）----
  S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(1).default("weave-media"),
  S3_ACCESS_KEY_ID: z.string().min(1).default(DEV_S3_ACCESS_KEY_ID),
  S3_SECRET_ACCESS_KEY: z.string().min(1).default(DEV_S3_SECRET_ACCESS_KEY),
  /** MinIO 只支持 path-style；COS 必须关。 */
  S3_FORCE_PATH_STYLE: booleanEnv(true),
  /** 公开读域名（CDN）；缺省回落到 `S3_ENDPOINT/<bucket>`，本地即 MinIO 公开读地址。 */
  MEDIA_BASE_URL: z.string().url().optional(),
  /** 上传预签名有效期（秒）。 */
  MEDIA_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().max(604_800).default(600),
  /**
   * 手工录入客户回复的原始 payload 保留天数（合规项）。
   * 到期后由 `pnpm --filter @weave-order/api maintain:inbound` 清空 `raw_payload`。
   */
  INBOUND_RAW_RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(30),
  /** 打印代理 token 的 HS256 密钥；生产必须覆盖为 ≥32 字节随机值。 */
  PRINT_AGENT_SECRET: z.string().min(32).default(DEV_PRINT_AGENT_SECRET),
  /** 服务端 A4 PDF 的中文字体（TTF/OTF；TTC 不受支持）。 */
  PRINT_CJK_FONT_PATH: z.string().optional(),
  /** 可选：headless Chromium 路径，用于 HTML→PDF 精确渲染；缺省走内置版式。 */
  PRINT_CHROME_PATH: z.string().optional(),
  /** 个人访问凭据（CLI / agent）哈希的 pepper；生产必须覆盖为 ≥32 字节随机值。 */
  PERSONAL_TOKEN_PEPPER: z.string().min(16).default(DEV_PERSONAL_TOKEN_PEPPER),
  /** 演示/seed 落库的租户；缺省为迁移内置的 default 租户。dev persona 端点读同一个值。 */
  SEED_TENANT_ID: z.string().uuid().optional(),
  /** 演示成员的 Casdoor org 标记（仅目录查询校验用，不参与授权）。 */
  SEED_ORG: z.string().min(1).max(128).optional(),
  /** CLI 登录确认页所在的租户端 Web 地址（与 API 分开部署）。 */
  WEB_APP_URL: z.string().url().default("http://localhost:3001"),
  /** 控制面地址：自助开通的公司要登记试用订阅。缺省时不登记（本地/单机模式）。 */
  PLATFORM_API_URL: z.string().url().optional(),
  /** 出站通知：log（默认，只记日志不发送）或 webhook（交给自建网关调邮件/短信服务商）。 */
  NOTIFY_PROVIDER: z.enum(["log", "webhook"]).default("log"),
  NOTIFY_WEBHOOK_URL: z.string().url().optional(),
  NOTIFY_TOKEN: z.string().optional(),
  /** 新公司默认每月 credits（1 credit = 1,000 tokens）；套餐升级时由平台调整。 */
  DEFAULT_MONTHLY_CREDITS: z.coerce.number().int().positive().default(20000),
  /** CLI 设备登录确认码有效期与轮询间隔（秒）。 */
  DEVICE_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  DEVICE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse(source);
  // 测试环境的硬要求是与生产同构；`WEAVE_ENV=test + AUTH_MODE=dev` 会让
  // 「重置脚本可跑」与「生产态门控」同时成立两种互相矛盾的前提，必须启动期拒绝。
  if (env.WEAVE_ENV === "test" && !isProductionLike(env)) {
    throw new Error(
      "WEAVE_ENV=test 必须与生产同构（NODE_ENV=production + AUTH_MODE=oidc）；" +
        "否则测试环境会绕过 Secure Cookie / fail-closed 401 等生产门控。",
    );
  }
  // 与 APP_DATABASE_URL 的生产硬校验同一原则：生产/OIDC 模式不允许静默使用公开占位密钥。
  // 默认 secret 已知时，IP/UA 加盐哈希可被反查，「IP 只存哈希」的隐私承诺会被削弱。
  if (isProductionLike(env) && env.QUOTE_SHARE_SECRET === DEV_QUOTE_SHARE_SECRET) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 QUOTE_SHARE_SECRET（≥32 字节随机值，例如 openssl rand -hex 32）；" +
        "否则报价链接与匿名 IP 哈希会使用公开的默认密钥。",
    );
  }
  if (isProductionLike(env) && env.PERSONAL_TOKEN_PEPPER === DEV_PERSONAL_TOKEN_PEPPER) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 PERSONAL_TOKEN_PEPPER（≥16 字节随机值，例如 openssl rand -hex 32）；" +
        "否则 PAT 的哈希 pepper 是公开默认值。",
    );
  }
  if (isProductionLike(env) && env.PRINT_AGENT_SECRET === DEV_PRINT_AGENT_SECRET) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 PRINT_AGENT_SECRET（≥32 字节随机值），否则任何人都能伪造打印代理 token。",
    );
  }
  if (isProductionLike(env) && env.ONBOARDING_SECRET === DEV_ONBOARDING_SECRET) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 ONBOARDING_SECRET（≥32 字节随机值），否则任何人都能伪造开通链接、自建公司空间。",
    );
  }
  // 与 secret 同一处、同一风格：只有真的会调用企业网关时才要求 URL + Key，
  // local-rule / 开发环境不因缺网关凭据而阻断启动。请求期 provider 创建还有一层兜底。
  if (isProductionLike(env) && env.LLM_PROVIDER === "openai-compatible") {
    if (!env.LLM_BASE_URL || isLoopbackUrl(env.LLM_BASE_URL)) {
      throw new Error(
        "生产/OIDC 模式使用 LLM_PROVIDER=openai-compatible 时必须配置 LLM_BASE_URL" +
          "（企业 OpenAI 兼容网关的 /v1 地址，例如 https://gateway.example.com/v1）；" +
          "未配置或指向本机时拒绝启动。",
      );
    }
    if (isPlaceholderLlmKey(env.LLM_API_KEY ?? "")) {
      throw new Error(
        "生产/OIDC 模式使用 LLM_PROVIDER=openai-compatible 时必须配置有效的 LLM_API_KEY" +
          "（网关令牌）；占位 key 或未配置时拒绝启动。",
      );
    }
  }
  // 语义检索同理：选了真实 provider 却没有 key，就直接拒绝启动，不退回哈希向量。
  if (
    env.EMBEDDING_PROVIDER === "dashscope-text-v3" &&
    !(env.EMBEDDING_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "").trim()
  ) {
    throw new Error(
      "EMBEDDING_PROVIDER=dashscope-text-v3 需要 EMBEDDING_API_KEY 或 DASHSCOPE_API_KEY；" +
        "没有 key 请改回 local-stub（哈希向量不携带语义，不能用于语义检索）。",
    );
  }
  if (env.EMBEDDING_PROVIDER === "dashscope-text-v3" && env.EMBEDDING_DIMENSION !== 1024) {
    throw new Error(
      `EMBEDDING_DIMENSION=${env.EMBEDDING_DIMENSION} 与 sample_text_embeddings.embedding vector(1024) 不一致；` +
        "改维度必须同时新增迁移与 HNSW 索引。",
    );
  }
  // 图像向量同理：选了真实多模态模型却没 key 就拒绝启动，绝不退回哈希向量。
  if (
    env.IMAGE_EMBEDDING_PROVIDER === "dashscope-qwen3-vl" &&
    !(env.IMAGE_EMBEDDING_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "").trim()
  ) {
    throw new Error(
      "IMAGE_EMBEDDING_PROVIDER=dashscope-qwen3-vl 需要 IMAGE_EMBEDDING_API_KEY 或 DASHSCOPE_API_KEY；" +
        "没有 key 请改回 local-stub（哈希向量不携带视觉语义，不能用于以图找样）。",
    );
  }
  if (
    env.IMAGE_EMBEDDING_PROVIDER === "dashscope-qwen3-vl" &&
    !DASHSCOPE_MULTIMODAL_DIMENSIONS.includes(
      env.IMAGE_EMBEDDING_DIMENSION as (typeof DASHSCOPE_MULTIMODAL_DIMENSIONS)[number],
    )
  ) {
    throw new Error(
      `IMAGE_EMBEDDING_DIMENSION=${env.IMAGE_EMBEDDING_DIMENSION} 不是 ${env.IMAGE_EMBEDDING_MODEL} 支持的维度；` +
        `可选：${DASHSCOPE_MULTIMODAL_DIMENSIONS.join(" / ")}`,
    );
  }
  if (
    env.CAPTION_FALLBACK &&
    !(env.IMAGE_EMBEDDING_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "").trim()
  ) {
    throw new Error(
      "CAPTION_FALLBACK=true 需要 IMAGE_EMBEDDING_API_KEY 或 DASHSCOPE_API_KEY（caption 走同一个 key）。",
    );
  }
  // caption 兜底最终要落到**文本语义检索**上：文本 provider 还是哈希 stub 时，
  // 兜底会返回一组「按描述检索」但没有语义的结果 —— 宁可拒绝启动。
  if (env.CAPTION_FALLBACK && env.EMBEDDING_PROVIDER === "local-stub") {
    throw new Error(
      "CAPTION_FALLBACK=true 需要真实文本 embedding（EMBEDDING_PROVIDER=dashscope-text-v3）；" +
        "local-stub 的哈希向量做文本检索没有意义。",
    );
  }
  // 图片链路不允许「悄悄退回 base64 / 本地磁盘」：没有对象存储凭据就拒绝启动。
  if (
    isProductionLike(env) &&
    (env.S3_ACCESS_KEY_ID === DEV_S3_ACCESS_KEY_ID ||
      env.S3_SECRET_ACCESS_KEY === DEV_S3_SECRET_ACCESS_KEY)
  ) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY（对象存储凭证）；" +
        "否则图片会以公开的 dev 凭据写入桶。",
    );
  }
  // 以下五项的共同点：配错时**进程能起来、接口也返回 200**，只有客户看到的东西是坏的
  // （链接指向 localhost、签名主机名错、通知不发、试用订阅不登记）。所以必须在启动期拒绝。
  assertProductionSiteUrl(
    env,
    "PUBLIC_APP_URL",
    "客户报价分享链接",
    "https://<quote-域名>（例如 https://quote.weaveorder.cn）",
  );
  assertProductionSiteUrl(
    env,
    "WEB_APP_URL",
    "开通链接 / CLI 登录确认页",
    "https://<租户端域名>（例如 https://weave.wnbgj.com）",
  );
  // MinIO 的 path-style 在 COS 上会让签名主机名变成 <endpoint>/<bucket>/<key>，
  // 浏览器 PUT 403、confirm HEAD 当对象不存在；默认值恰好是 true，漏注入即静默踩中。
  if (isProductionLike(env) && env.S3_FORCE_PATH_STYLE) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 S3_FORCE_PATH_STYLE=false（腾讯云 COS 只支持虚拟主机风格签名）；" +
        "漏配会回落到本地 MinIO 的 path-style 默认值，导致预签名 URL 的主机名错误、上传与确认全部失败。",
    );
  }
  // 不配 = 自助开通只建公司、不登记试用订阅，账单视图少一条且没有任何报错。
  if (isProductionLike(env) && !env.PLATFORM_API_URL) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 PLATFORM_API_URL（控制面地址，例如 https://platform.<你的域名>）；" +
        "不配时自助开通的公司不会被登记试用订阅，且不会有任何报错。",
    );
  }
  if (isProductionLike(env) && env.PLATFORM_API_URL && isLoopbackUrl(env.PLATFORM_API_URL)) {
    throw new Error(
      `生产/OIDC 模式的 PLATFORM_API_URL 不能指向本机（当前 ${env.PLATFORM_API_URL}）；` +
        "请改成控制面的正式地址，例如 https://platform.<你的域名>。",
    );
  }
  // log 是显式降级：发送结果为 ok:false，由调用方展示手动处理，不阻断启动。
  if (isProductionLike(env) && env.NOTIFY_PROVIDER === "webhook" && !env.NOTIFY_WEBHOOK_URL) {
    throw new Error(
      "NOTIFY_PROVIDER=webhook 必须同时配置 NOTIFY_WEBHOOK_URL（通知网关地址，例如 https://notify.<你的域名>/send）；" +
        "否则发送通道仍然不存在。",
    );
  }
  if (isProductionLike(env) && env.NOTIFY_WEBHOOK_URL && isLoopbackUrl(env.NOTIFY_WEBHOOK_URL)) {
    throw new Error(
      `生产/OIDC 模式的 NOTIFY_WEBHOOK_URL 不能指向本机（当前 ${env.NOTIFY_WEBHOOK_URL}）；` +
        "请改成通知网关的正式地址。",
    );
  }
  return env;
}

/** 回环/本机域名：这些地址在客户手机上打开就是白屏，生产态一律拒绝。 */
const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "host.docker.internal",
]);

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return LOOPBACK_HOSTNAMES.has(host) || host.endsWith(".localhost");
  } catch {
    // zod 已经保证是 URL；解析失败按「不可信」处理，交给对应门禁报错。
    return true;
  }
}

/**
 * 站点根地址（发给客户的链接前缀）的生产态校验：
 * 拒绝 localhost / 非 https，错误信息必须写清变量名与正确形态。
 */
function assertProductionSiteUrl(
  env: Env,
  key: "PUBLIC_APP_URL" | "WEB_APP_URL",
  usage: string,
  correctForm: string,
): void {
  if (!isProductionLike(env)) return;
  const value = env[key];
  if (isLoopbackUrl(value)) {
    throw new Error(
      `生产/OIDC 模式必须显式配置 ${key}（${usage} 的站点根地址，正确形态：${correctForm}）；` +
        `当前是 ${value}，生成的链接客户打开会白屏，而接口仍返回 200。`,
    );
  }
  if (!/^https:\/\//i.test(value)) {
    throw new Error(
      `生产/OIDC 模式的 ${key} 必须是 https（当前 ${value}）；${usage} 会在微信/浏览器里被拦截。`,
    );
  }
}
