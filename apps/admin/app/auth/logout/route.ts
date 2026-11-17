import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isSameOriginRequest, logoutResponse } from "@/src/logout";

export const runtime = "nodejs";

/**
 * 只导出 POST：GET 不再清会话。
 *
 * 之前 GET 直接删 cookie，而侧栏「退出」是 <Link>，Next 预取视口内链接时
 * 就把用户静默登出了。现在登出统一走 POST 表单（见 src/logout-form.tsx）。
 */
export function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return new NextResponse("已拒绝跨站登出请求", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return logoutResponse(request);
}

/** GET 只给一个确认页：旧链接/书签/残留预取都不会再产生副作用。 */
export function GET() {
  return new NextResponse(CONFIRM_PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const CONFIRM_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>退出登录 · 万鸟科技</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #17212e; font-family: system-ui, -apple-system, sans-serif; }
      main { width: min(420px, calc(100vw - 48px)); background: #fff; border: 1px solid #dde3ea; border-radius: 12px; padding: 28px; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 20px; color: #53627a; font-size: 14px; line-height: 1.7; }
      form { margin: 0; }
      button { padding: 9px 18px; border-radius: 8px; border: 1px solid #1f6feb; background: #1f6feb; color: #fff; font-size: 14px; cursor: pointer; }
      a { margin-left: 12px; color: #1f6feb; font-size: 14px; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>要退出登录吗？</h1>
      <p>退出会立即清除当前会话。直接打开这个地址不会登出，只有点击下面的按钮才会。</p>
      <form method="post" action="/auth/logout">
        <button type="submit">退出登录</button>
        <a href="/">返回控制台</a>
      </form>
    </main>
  </body>
</html>`;
