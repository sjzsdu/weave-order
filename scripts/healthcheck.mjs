/**
 * 容器 healthcheck 探针（Node 内置 fetch，不依赖 curl/wget）。
 * 用法：node scripts/healthcheck.mjs <url> [maxStatus]
 *   maxStatus 默认 500：HTTP 状态码 < maxStatus 视为健康。
 *   - 业务健康端点传 400（只接受 2xx/3xx）
 *   - 前端/静态站传 500（Next 的 / 可能 307，quote basePath 根路径可能 404，都算在监听）
 */
const url = process.argv[2];
const maxStatus = Number(process.argv[3] ?? 500);

if (!url) {
  console.error("用法: node scripts/healthcheck.mjs <url> [maxStatus]");
  process.exit(2);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 4000);
try {
  const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
  console.log(`${url} -> ${response.status}`);
  process.exit(response.status > 0 && response.status < maxStatus ? 0 : 1);
} catch (cause) {
  console.error(`${url} -> ${cause instanceof Error ? cause.message : cause}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}
