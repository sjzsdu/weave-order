import { NextResponse } from "next/server";
import { isProductionLike } from "@/runtime-mode";

/**
 * 部署期配置（浏览器侧读取）。
 *
 * 为什么走一个运行时路由而不是 `NEXT_PUBLIC_*`：`NEXT_PUBLIC_` 在构建时被内联进
 * 客户端包，等于把域名钉死在镜像里——同一个镜像就没法部署到不同环境。
 * 这里每次请求都读容器的环境变量，客户端从 window.__WEAVE_CONFIG__ 取
 * （见 src/analytics.ts 的 syncAnalyticsConfig）。
 *
 * 下发内容都是公开信息：统计域名 / project key（PostHog 的 project key 本来就是
 * 公开标识，不是密钥），以及 `productionLike`（api 与 web 共用的生产态判定）。
 * 客户端不能自己读 AUTH_MODE，所以生产态必须由服务端现算后下发。
 */
export const dynamic = "force-dynamic";

export function GET() {
  const config = {
    analytics: {
      provider: (process.env.ANALYTICS_PROVIDER ?? "").trim(),
      domain: (process.env.ANALYTICS_DOMAIN ?? "").trim(),
      host: (process.env.ANALYTICS_HOST ?? "").trim(),
      key: (process.env.ANALYTICS_KEY ?? "").trim(),
    },
    productionLike: isProductionLike(),
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
