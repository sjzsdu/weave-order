import { PrintError } from "./template-engine";

/**
 * 打印模板的 HTML 安全闸。
 *
 * 模板正文由成员发布，最终会写盘交给 headless Chromium 渲染；
 * 因此「允许什么」必须是白名单式的静态约束，而不是渲染时再兜底：
 *   - 执行：<script> / <iframe> / <object> / <embed> / <base> / <link> / <form>
 *           以及 on* 事件属性、javascript: / vbscript: 伪协议；
 *   - 外联：远程 src/srcset/href/poster/background、CSS url() 与 @import，
 *           防止渲染宿主机被当作跳板探测内网 / 云元数据。
 *
 * 发布时 `assertHtmlTemplateSafe` 直接拒绝，渲染前 `sanitizeHtmlForPrint`
 * 再洗一遍（防的是历史上已入库的旧模板），两层都不依赖 Chromium 行为。
 */

const VIOLATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<\s*script\b/i, "不允许 <script> 标签"],
  [
    /<\s*(iframe|frame|frameset|object|embed|applet|base|link|form)\b/i,
    "不允许可执行 / 可外联的标签（iframe、object、embed、base、link、form 等）",
  ],
  [/<\s*meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh/i, "不允许 <meta http-equiv=refresh>"],
  [/\son[a-z]+\s*=/i, "不允许 on* 事件属性（onclick、onload 等）"],
  [/(?:javascript|vbscript)\s*:/i, "不允许 javascript: / vbscript: 伪协议"],
  [/data\s*:\s*text\/html/i, "不允许 data:text/html 内联文档"],
  [
    /\b(?:src|srcset|href|poster|background|action|formaction)\s*=\s*(?:"|')?\s*(?:https?\s*:|ftp\s*:|\/\/)/i,
    "不允许引用远程资源（src/href 只能指向本模板内容或 data:）",
  ],
  [/url\(\s*(?:"|')?\s*(?:https?\s*:|ftp\s*:|\/\/|data\s*:\s*text\/html)/i, "CSS url() 不允许远程地址"],
  [/@import\b/i, "不允许 CSS @import"],
  [/expression\s*\(/i, "不允许 CSS expression()"],
];

/** 返回第一条命中的违规说明；安全时返回 null（便于单测与错误详情）。 */
export function templateSafetyViolation(body: string): string | null {
  for (const [pattern, message] of VIOLATIONS) {
    if (pattern.test(body)) return message;
  }
  return null;
}

/** 发布 HTML 模板前调用；非 HTML 格式（ZPL/TSPL）是纯文本指令，不走这里。 */
export function assertHtmlTemplateSafe(body: string): void {
  const violation = templateSafetyViolation(body);
  if (violation) {
    throw new PrintError("PRINT_TEMPLATE_UNSAFE", `模板正文不安全：${violation}`, { violation });
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isUnsafeUrl(value: string): boolean {
  // 去掉空白与控制字符，避免 `java\nscript:` 之类的绕过写法。
  const url = unquote(value)
    .replace(/\s/g, "")
    .replace(/\p{Cc}/gu, "")
    .toLowerCase();
  return (
    url.startsWith("http:") ||
    url.startsWith("https:") ||
    url.startsWith("ftp:") ||
    url.startsWith("//") ||
    url.startsWith("javascript:") ||
    url.startsWith("vbscript:") ||
    url.startsWith("data:text/html")
  );
}

/**
 * 渲染前的最后一道清洗：即使旧模板已入库，也不会把远程资源或脚本带进 Chromium。
 * 只处理危险构造，样式与版式原样保留。
 */
export function sanitizeHtmlForPrint(html: string): string {
  let out = html;

  // 成对标签连同内容一起删（script 正文不执行，但也没必要留给渲染器）。
  out = out.replace(
    /<\s*(script|iframe|object|embed|applet|frame|frameset)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    "",
  );
  // 自闭合 / 未闭合的同类标签，以及 base/link/form/meta refresh。
  out = out.replace(
    /<\s*(script|iframe|object|embed|applet|frame|frameset|base|link|form)\b[^>]*\/?>/gi,
    "",
  );
  out = out.replace(/<\s*meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, "");

  // 事件属性：onclick="…" / onload=…。
  out = out.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // 远程资源属性统一指向 about:blank（不会被解析成网络请求）。
  out = out.replace(
    /(\b(?:src|srcset|href|poster|background|action|formaction)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (match, prefix: string, value: string) =>
      isUnsafeUrl(unquote(value)) ? `${prefix}"about:blank"` : match,
  );

  // CSS 里的 url(远程) 与 @import。
  out = out.replace(/url\(\s*("[^"]*"|'[^']*'|[^)]*)\s*\)/gi, (match, value: string) =>
    isUnsafeUrl(unquote(value)) ? "none" : match,
  );
  out = out.replace(/@import[^;{}]*(?:;|(?=\s*\}))?/gi, "");

  return out;
}
