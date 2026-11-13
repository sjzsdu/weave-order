import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { PlatformErrorFilter } from "./http/error.filter";
import { loadEnv } from "./env";

/**
 * 控制面独立进程（默认 :3002），与租户 API（:3000）物理隔离。
 * 它只握有 PLATFORM_DATABASE_URL，进程里不存在租户业务库连接。
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useGlobalFilters(new PlatformErrorFilter());
  app.enableCors({
    origin: env.PLATFORM_CORS_ORIGIN.split(",").map((item) => item.trim()),
    credentials: true,
  });
  app.useBodyParser("json", { limit: "2mb" });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  console.log(
    `✔ WeaveOrder 控制面 → http://localhost:${env.PORT}/platform/api/health（auth=${env.PLATFORM_AUTH_MODE}）`,
  );
}

void bootstrap();
