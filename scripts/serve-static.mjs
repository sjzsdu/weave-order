/**
 * 静态产物托管：只服务构建产物，不做反向代理。
 * 用 Node 内置模块，不引入 serve/http-server 等新依赖（供应链最小）。
 *
 * 两种用途，行为由命令行开关区分：
 *   - 移动端 H5/PWA（SPA）：未命中路由回退到 index.html，静态资源 immutable 长缓存。
 *   - 官网静态站：未命中返回站点自己的 404.html（状态码仍是 404，不能是 200），
 *     HTML / sitemap / llms.txt 每次回源校验，其余静态资源缓存 30 天。
 *
 * 用法：node scripts/serve-static.mjs <root> [选项]
 *   --spa | --no-spa            未命中时是否回退 index.html（默认 --spa）
 *   --404 <file>                自定义 404 页（相对 root），状态码仍是 404
 *   --no-cache-ext <ext,...>    用 no-cache 的扩展名（默认 html,webmanifest）
 *   --asset-cache <value>       静态资源 Cache-Control 值
 *   --gzip                      文本类型按 Accept-Encoding 压缩
 *   --security-headers          补 X-Frame-Options / Referrer-Policy
 *   --healthz                   提供 /healthz 供容器探针使用
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** 可压缩的文本类型（与 nginx 的 gzip_types 对齐）。 */
const COMPRESSIBLE = new Set([
  "text/plain",
  "text/html",
  "text/css",
  "text/xml",
  "application/xml",
  "application/javascript",
  "text/javascript",
  "application/json",
  "application/manifest+json",
  "image/svg+xml",
]);

/* ------------------------------------------------------------------ 参数解析 */
const args = process.argv.slice(2);
const root = path.resolve(args.shift() ?? "apps/mobile/dist");
const port = Number(process.env.PORT ?? 8080);

const options = {
  spa: true,
  notFound: null,
  noCacheExt: ["html", "webmanifest"],
  assetCache: "public, max-age=31536000, immutable",
  gzip: false,
  securityHeaders: false,
  healthz: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case "--spa":
      options.spa = true;
      break;
    case "--no-spa":
      options.spa = false;
      break;
    case "--404":
      options.notFound = args[++i] ?? null;
      break;
    case "--no-cache-ext":
      options.noCacheExt = (args[++i] ?? "").split(",").filter(Boolean);
      break;
    case "--asset-cache":
      options.assetCache = args[++i] ?? options.assetCache;
      break;
    case "--gzip":
      options.gzip = true;
      break;
    case "--security-headers":
      options.securityHeaders = true;
      break;
    case "--healthz":
      options.healthz = true;
      break;
    default:
      console.error(`未知参数：${arg}`);
      process.exit(2);
  }
}

if (!options.notFound && !options.spa) {
  console.error("--no-spa 需要配合 --404 指定 404 页，否则未命中会返回空白 404");
  process.exit(2);
}

const NO_CACHE_EXT = new Set(options.noCacheExt.map((e) => e.replace(/^\./, "").toLowerCase()));

/* ------------------------------------------------------------------ 响应头 */
function baseHeaders(contentType) {
  const headers = {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  };
  if (options.securityHeaders) {
    headers["x-frame-options"] = "SAMEORIGIN";
    headers["referrer-policy"] = "strict-origin-when-cross-origin";
  }
  return headers;
}

/** 按扩展名决定缓存策略：HTML / sitemap / llms.txt 每次回源，其余长缓存。 */
function cacheControl(file) {
  const ext = path.extname(file).replace(/^\./, "").toLowerCase();
  return NO_CACHE_EXT.has(ext) ? "no-cache" : options.assetCache;
}

/* ------------------------------------------------------------------ 服务 */
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const requested = decodeURIComponent(url.pathname);

    if (options.healthz && requested === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok\n");
      return;
    }

    // 防目录穿越：解析后的路径必须仍在 root 内
    let file = path.resolve(root, `.${requested}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = path.join(file, "index.html");
      info = await stat(file).catch(() => null);
    }

    let status = 200;
    if (!info?.isFile()) {
      if (options.notFound) {
        // 站点自己的 404 页：内容是它的，但状态码必须是 404
        // （返回 200 会让搜索引擎把不存在的地址当成正常页面收录）。
        file = path.resolve(root, options.notFound);
        info = await stat(file).catch(() => null);
        status = 404;
      } else if (options.spa) {
        // 前端路由回退
        file = path.join(root, "index.html");
        info = await stat(file).catch(() => null);
      }
    }
    if (!info?.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
      return;
    }

    const ext = path.extname(file);
    const contentType = MIME[ext] ?? "application/octet-stream";
    const headers = {
      ...baseHeaders(contentType),
      "cache-control": cacheControl(file),
    };

    const acceptEncoding = String(req.headers["accept-encoding"] ?? "");
    const compress =
      options.gzip &&
      COMPRESSIBLE.has(contentType.split(";")[0].trim()) &&
      /\bgzip\b/.test(acceptEncoding);

    if (compress) {
      headers["content-encoding"] = "gzip";
      headers.vary = "Accept-Encoding";
      res.writeHead(status, headers);
      await pipeline(createReadStream(file), createGzip(), res);
      return;
    }

    res.writeHead(status, headers);
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(500).end("Internal Server Error");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`✔ static server → 0.0.0.0:${port} (root=${root})`);
});
