import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * 移动端 H5/PWA 静态托管：只服务构建产物，SPA 回退到 index.html。
 * 用 Node 内置模块，不引入 serve/http-server 等新依赖（供应链最小）。
 * 用法：node scripts/serve-static.mjs apps/mobile/dist
 */
const root = path.resolve(process.argv[2] ?? "apps/mobile/dist");
const port = Number(process.env.PORT ?? 8080);

/**
 * 部署期注入 API 基址。
 *
 * 移动端是编译产物，`TARO_APP_API_BASE` 是构建期常量；但域名应该在部署时决定，
 * 所以这里在返回 index.html 时插一段内联脚本，把部署环境的地址挂到 window，
 * 由 apps/mobile/src/lib/runtime.ts 优先读取。同一个镜像可以部署到任何域名。
 * 未设置 WEAVE_API_BASE 时不注入，前端回落到构建期默认值。
 */
const RUNTIME_API_BASE = (process.env.WEAVE_API_BASE ?? "").trim();
const indexPath = path.join(root, "index.html");
let indexHtmlPromise = null;

async function renderIndexHtml() {
  const html = await readFile(indexPath, "utf8");
  if (!RUNTIME_API_BASE) return html;
  const snippet = `<script>window.__WEAVE_API_BASE__=${JSON.stringify(RUNTIME_API_BASE).replace(/</g, "\\u003c")};</script>`;
  return html.includes("</head>")
    ? html.replace("</head>", `${snippet}</head>`)
    : `${snippet}${html}`;
}

function getIndexHtml() {
  indexHtmlPromise ??= renderIndexHtml();
  return indexHtmlPromise;
}

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
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const requested = decodeURIComponent(url.pathname);
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
    if (!info?.isFile()) {
      // PWA 前端路由回退
      file = path.join(root, "index.html");
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404).end("Not Found");
      return;
    }

    const ext = path.extname(file);
    // 回退与直达都落到同一个 index.html，统一走注入后的版本。
    if (file === indexPath) {
      const html = await getIndexHtml();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      res.end(html);
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control":
        ext === ".html" || ext === ".webmanifest"
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(500).end("Internal Server Error");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    `✔ mobile PWA static server → 0.0.0.0:${port} (root=${root}, apiBase=${RUNTIME_API_BASE || "<构建期默认>"})`,
  );
});
