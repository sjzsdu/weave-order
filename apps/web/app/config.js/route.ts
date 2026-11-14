import { NextResponse } from "next/server";

/**
 * 部署期配置（浏览器侧读取）。
 *
 * 为什么走一个运行时路由而不是 `NEXT_PUBLIC_*`：`NEXT_PUBLIC_` 在构建时被内联进
 * 客户端包，等于把域名钉死在镜像里——同一个镜像就没法部署到不同环境。
 * 这里每次请求都读容器的环境变量，客户端再用 `readRuntimeConfig()` 取。
 *
 * 内容只有公开信息（官网地址、支持邮箱），不放任何密钥。
 */
export const dynamic = "force-dynamic";

export function GET() {
  const config = {
    supportEmail: (process.env.SUPPORT_EMAIL ?? "").trim(),
    marketingUrl: (process.env.MARKETING_URL ?? "").trim().replace(/\/+$/, ""),
  };
  const body = [
    `window.__WEAVE_CONFIG__=${JSON.stringify(config).replace(/</g, "\\u003c")};`,
    `window.dispatchEvent(new Event("weave:config"));`,
  ].join("");
  return new NextResponse(body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
