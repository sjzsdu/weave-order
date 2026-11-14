/**
 * 登录成功后的站内回跳地址白名单。
 *
 * `next` 会先写进 httpOnly cookie、再由 /auth/callback 用 `new URL(next, origin)`
 * 拼重定向地址。若不校验，攻击者可以用 `?next=https://evil.example` 或
 * `?next=//evil.example` 把登录成功后的用户带出本站（开放重定向）。
 * 与租户端 apps/web/src/public-origin.ts 的 safeNext 保持同一套口径。
 */
const DEFAULT_NEXT = "/";

export function safeNext(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_NEXT;
  const value = raw.trim();
  // 只收单个斜杠开头的站内绝对路径；反斜杠与控制字符是常见的 URL 解析绕过手法。
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return DEFAULT_NEXT;
  // 逐个码点判断控制字符，避免 no-control-regex 误报。
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return DEFAULT_NEXT;
  }

  try {
    const url = new URL(value, "https://weave.invalid");
    if (url.origin !== "https://weave.invalid") return DEFAULT_NEXT;
    // 官网静态页不属于控制台；认证路由会回环；/api 是 BFF。
    if (url.pathname.endsWith(".html")) return DEFAULT_NEXT;
    if (
      url.pathname === "/login" ||
      url.pathname.startsWith("/auth/") ||
      url.pathname.startsWith("/api/")
    ) {
      return DEFAULT_NEXT;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_NEXT;
  }
}
