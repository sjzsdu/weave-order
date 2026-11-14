import type { ImagePayload } from "@weave-order/schema";

/**
 * 按 URL 取图（T-001 imageUrl 变体）。
 *
 * 安全边界：
 * - 只允许 `MEDIA_ALLOWED_HOSTS` 白名单内的主机（对象存储 / CDN 域名）；
 * - 非生产环境允许 http://localhost，生产只允许 https；
 * - 不跟随重定向（避免白名单被 30x 绕过）；
 * - 限制体积与超时；content-type 必须是 jpeg/png/webp。
 *
 * base64 只在进程内传给 embedding provider，不会回到 HTTP 响应，也不是客户端入参。
 */

export interface ImageFetcher {
  fetchImage(url: string): Promise<ImagePayload>;
}

export interface ImageFetcherOptions {
  allowedHosts: string[];
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MIME_ALIASES: Record<string, ImagePayload["mimeType"]> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map(normalizeHost).filter(Boolean);
}

/**
 * 取图白名单 = `MEDIA_ALLOWED_HOSTS` ∪ `MEDIA_BASE_URL` 的主机。
 *
 * 图片读模型里的 URL 就是 MEDIA_BASE_URL 拼出来的；只认前者会让 imageUrl 变体
 * 在「配了 CDN 但忘了加白名单」时永久禁用。未配 MEDIA_BASE_URL 时对象存储地址
 * （本地 MinIO）同样加入，保证本地链路可用；生产必须显式配 CDN。
 */
export function resolveAllowedHosts(source: NodeJS.ProcessEnv): string[] {
  const hosts = parseAllowedHosts(source.MEDIA_ALLOWED_HOSTS);
  const candidates = source.MEDIA_BASE_URL
    ? [source.MEDIA_BASE_URL]
    : [source.S3_ENDPOINT ?? "http://localhost:9000"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      hosts.push(normalizeHost(new URL(candidate).hostname.replace(/^\[|\]$/g, "")));
    } catch {
      // 非法 URL 不扩大白名单；取图时仍会按 MEDIA_ALLOWED_HOSTS 判断。
    }
  }
  return [...new Set(hosts.filter(Boolean))];
}

export class HttpImageFetcher implements ImageFetcher {
  private readonly allowedHosts: Set<string>;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ImageFetcherOptions) {
    this.allowedHosts = new Set(options.allowedHosts.map(normalizeHost));
    this.maxBytes = Math.min(options.maxBytes ?? 2_000_000, 10_000_000);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchImage(url: string): Promise<ImagePayload> {
    if (this.allowedHosts.size === 0) {
      throw new Error("MEDIA_ALLOWED_HOSTS 未配置，拒绝按 URL 取图");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("imageUrl 不是合法 URL");
    }
    if (parsed.username || parsed.password) throw new Error("imageUrl 不允许携带凭据");
    const host = normalizeHost(parsed.hostname.replace(/^\[|\]$/g, ""));
    if (!this.allowedHosts.has(host)) {
      throw new Error(`imageUrl 主机不在白名单：${host}`);
    }
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
      throw new Error("imageUrl 必须是 https（本地开发允许 http://localhost）");
    }

    const response = await this.fetchImpl(parsed.toString(), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`取图失败（HTTP ${response.status}）`);
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    const mimeType = MIME_ALIASES[contentType.toLowerCase()];
    if (!mimeType) {
      throw new Error(`不支持的图片类型：${contentType || "unknown"}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new Error(`图片超过体积上限（${this.maxBytes} 字节）`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error("图片内容为空");
    if (buffer.length > this.maxBytes) {
      throw new Error(`图片超过体积上限（${this.maxBytes} 字节）`);
    }
    return { mimeType, base64: buffer.toString("base64") };
  }
}

export function createImageFetcherFromEnv(source: NodeJS.ProcessEnv = process.env): ImageFetcher {
  const maxBytes = Number(source.MEDIA_MAX_BYTES ?? "");
  return new HttpImageFetcher({
    allowedHosts: resolveAllowedHosts(source),
    ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes } : {}),
  });
}
