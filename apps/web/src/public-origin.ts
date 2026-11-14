/**
 * 租户端 Web 的公网地址（容器运行时由 WEB_APP_URL 注入）。
 *
 * 容器里 request.nextUrl.origin 是内部地址（localhost:3001），任何「跳回本应用」的
 * Location 都不能拿它兜底——否则登录成功、登录失败、登出都会把浏览器带回容器地址。
 *
 * 铁律：
 * - 域名只有一个来源：WEB_APP_URL。代码里不写死任何域名。
 * - 生产环境缺变量直接报错，不静默回退到请求来源地址（静默回退会把线上问题藏起来）。
 * - 开发环境允许回退到请求来源地址，本地 `pnpm dev` 不必额外配置。
 */
export function publicOrigin(fallbackOrigin: string): string {
  const configured = process.env.WEB_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置 WEB_APP_URL（租户端 Web 公网地址），不能回退到请求来源地址");
  }
  return fallbackOrigin.replace(/\/$/, "");
}

const DEFAULT_NEXT = "/today";

/**
 * 登录后的回跳地址只接受「本应用内」的路径，其他一律回工作台首页。
 *
 * 为什么必须校验：/auth/callback 用 `new URL(next, origin)` 拼 Location，
 * next 来自 query/cookie（用户可构造）。不校验时 `https://evil.example` 或
 * `//evil.example` 会把已登录用户带去外站；官网误传的 `/download.html`
 * 这类静态页路径在 app 域不存在，登录成功后只会得到 404。
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_NEXT;
  const value = raw.trim();
  // 只收单个斜杠开头的站内绝对路径；反斜杠与控制字符是常见的 URL 解析绕过手法。
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return DEFAULT_NEXT;
  // 控制字符是常见的 URL 解析绕过手法；逐个码点判断，避免 no-control-regex 误报。
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return DEFAULT_NEXT;
  }

  try {
    const url = new URL(value, "https://weave.invalid");
    if (url.origin !== "https://weave.invalid") return DEFAULT_NEXT;
    // 官网静态页（*.html）不是工作台路由；回登录页 / 认证路由会造成跳转循环。
    if (url.pathname.endsWith(".html")) return DEFAULT_NEXT;
    if (url.pathname === "/login" || url.pathname.startsWith("/auth/")) return DEFAULT_NEXT;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_NEXT;
  }
}
