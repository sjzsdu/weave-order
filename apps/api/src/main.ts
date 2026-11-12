import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { loadEnv } from "./platform/env";

/**
 * 显式组合根。
 *
 * 1. 先校验环境契约（Zod），再启动；
 * 2. 生产环境禁止 dev 认证模式（网关工厂内也会再拦一次）；
 * 3. Nest DI 负责装配连接池 / 内核 / 工具 / 审批 / 网关。
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === "production" && env.AUTH_MODE === "dev") {
    throw new Error("生产环境必须设置 AUTH_MODE=oidc 并配置 Casdoor issuer/audience");
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 页面与 API 同机开发（Vite 5173 -> API 3000），允许跨端口调用。
  app.enableCors({ origin: true });
  // T-001 以图搜图的 base64 可能较大，单独放宽 JSON 上限。
  app.useBodyParser("json", { limit: "10mb" });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  console.log(
    `✔ WeaveOrder API → http://localhost:${env.PORT}/api/health（auth=${env.AUTH_MODE}）`,
  );
}

void bootstrap();
