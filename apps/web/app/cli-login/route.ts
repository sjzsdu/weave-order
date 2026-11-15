import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { publicOrigin } from "@/public-origin";
import { isProductionLike } from "@/runtime-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CLI 设备登录确认页（WAN-78）。
 *
 * 这是唯一知道「是谁在批准」的地方：浏览器带着 httpOnly 的 OIDC 会话 Cookie，
 * 服务端在这里把 Authorization 注入后调用 API；令牌永远不进浏览器脚本。
 *
 * 与 `/api/[...path]` BFF 同一套取 token 规则：
 * - 有 `weave_token` Cookie → 用它；
 * - 本地无 Casdoor → 回退 DEV_AUTH_TOKEN（生产态绝不回退）；
 * - 都没有 → 跳登录页，登录后回到本页。
 */

const TOKEN_COOKIE = "weave_token";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function apiBase(): string {
  return (process.env.API_PROXY_TARGET ?? "http://localhost:3000").replace(/\/$/, "");
}

function tokenFromRequest(request: NextRequest): string | null {
  const cookie = request.cookies.get(TOKEN_COOKIE)?.value;
  if (cookie) return cookie;
  if (!isProductionLike()) {
    return process.env.DEV_AUTH_TOKEN ?? "dev:demo:demo";
  }
  return null;
}

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  background:#f7f6f3;color:#1d1d1b}
.card{width:100%;max-width:440px;background:#fff;border:1px solid #e6e2da;border-radius:16px;
  padding:28px 26px;box-shadow:0 10px 30px rgba(30,25,15,.06)}
.brand{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#8a6a3b}
h1{margin:10px 0 6px;font-size:22px;line-height:1.35}
p.sub{margin:0 0 20px;color:#6b6459;font-size:14px;line-height:1.6}
label{display:block;font-size:13px;color:#4a453d;margin:14px 0 6px}
input[type=text]{width:100%;padding:11px 12px;border:1px solid #d9d3c8;border-radius:10px;
  font-size:15px;background:#fdfcf9}
input:focus{outline:2px solid #b98b4a;outline-offset:1px;border-color:#b98b4a}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;font-size:16px}
.check{display:flex;gap:10px;align-items:flex-start;margin-top:16px;font-size:13px;color:#4a453d}
.check input{margin-top:2px}
.actions{display:flex;gap:10px;margin-top:22px}
button{flex:1;padding:12px 14px;border-radius:10px;border:1px solid transparent;font-size:15px;cursor:pointer}
.primary{background:#1d1d1b;color:#fff}
.ghost{background:#fff;border-color:#d9d3c8;color:#4a453d}
.error{margin:0 0 16px;padding:10px 12px;border-radius:10px;background:#fdf1ef;border:1px solid #f2c7bf;
  color:#a3392a;font-size:13px}
.hint{margin-top:18px;font-size:12px;color:#8a8378;line-height:1.6}
code{background:#f4f1ea;border-radius:4px;padding:1px 5px;font-size:12px}
`;

function page(input: { userCode: string; error?: string }): string {
  const codeField = input.userCode
    ? `<input type="hidden" name="userCode" value="${escapeHtml(input.userCode)}" />
       <label>确认码</label>
       <input class="code" type="text" value="${escapeHtml(input.userCode)}" readonly />`
    : `<label for="userCode">确认码</label>
       <input class="code" id="userCode" name="userCode" type="text" placeholder="ABCD-EFGH"
              autocomplete="one-time-code" required />`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>织序 WeaveOrder · CLI 登录确认</title><style>${STYLE}</style></head>
<body><main class="card">
  <p class="brand">织序 WeaveOrder</p>
  <h1>确认 CLI 登录</h1>
  <p class="sub">一台命令行工具正在申请访问你的织序账号。确认后会签发一枚个人 API token，
  它只能看到你有权限的数据，并且可以随时撤销。</p>
  ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ""}
  <form method="post" action="/cli-login">
    ${codeField}
    <label class="check">
      <input type="checkbox" name="allowApprove" value="1" />
      <span>允许这台 CLI 代我审批（approve 作用域）。<br />
      不确定就不要勾选：默认只能读取和生成草稿，审批仍需回到网页。</span>
    </label>
    <div class="actions">
      <button class="ghost" type="submit" name="decision" value="deny">拒绝</button>
      <button class="primary" type="submit" name="decision" value="approve">批准登录</button>
    </div>
  </form>
  <p class="hint">确认码 10 分钟内有效，只能使用一次。若不是你本人发起，请直接关闭本页，并在
  <code>weave token list</code> 里检查是否有陌生凭据。</p>
</main></body></html>`;
}

function resultPage(input: { approved: boolean; userCode: string }): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>织序 WeaveOrder · CLI 登录${input.approved ? "已批准" : "已拒绝"}</title>
<style>${STYLE}</style></head>
<body><main class="card">
  <p class="brand">织序 WeaveOrder</p>
  <h1>${input.approved ? "已批准 CLI 登录" : "已拒绝 CLI 登录"}</h1>
  <p class="sub">${
    input.approved
      ? `确认码 <code>${escapeHtml(input.userCode)}</code> 已授权。回到终端，CLI 会自动完成登录。`
      : `确认码 <code>${escapeHtml(input.userCode)}</code> 已被拒绝，CLI 不会获得任何凭据。`
  }</p>
  <p class="hint">可以关闭本页。凭据管理：<code>weave token list</code> /
  <code>weave token revoke &lt;id&gt;</code>。</p>
</main></body></html>`;
}

function html(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export function GET(request: NextRequest): NextResponse {
  const userCode = request.nextUrl.searchParams.get("user_code") ?? "";
  if (!tokenFromRequest(request)) {
    const next = encodeURIComponent(`/cli-login?user_code=${userCode}`);
    return NextResponse.redirect(
      new URL(`/auth/login?next=${next}`, publicOrigin(request.nextUrl.origin)),
    );
  }
  return html(page({ userCode }));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const rawCode = form.get("userCode");
  const userCode = typeof rawCode === "string" ? rawCode : "";
  const approve = form.get("decision") === "approve"; // 只有显式点「批准」才算批准
  const allowApprove = form.get("allowApprove") === "1";

  const token = tokenFromRequest(request);
  if (!token) {
    const next = encodeURIComponent(`/cli-login?user_code=${userCode}`);
    return NextResponse.redirect(
      new URL(`/auth/login?next=${next}`, publicOrigin(request.nextUrl.origin)),
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}/api/auth/device/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userCode,
        approve,
        scopes: allowApprove ? ["read", "write", "approve"] : ["read", "write"],
      }),
      cache: "no-store",
    });
  } catch {
    return html(page({ userCode, error: "服务暂时不可达，请稍后重试。" }), 502);
  }

  if (!upstream.ok) {
    let message = "确认失败，请稍后重试。";
    try {
      const body = (await upstream.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // 上游不是 JSON 时保留通用提示。
    }
    return html(page({ userCode, error: message }), upstream.status);
  }

  return html(resultPage({ approved: approve, userCode }));
}
