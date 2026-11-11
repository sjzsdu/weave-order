import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { loadEnv } from "./platform/env";

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 页面与 API 同机开发（Vite 5173 -> API 3000），允许跨端口调用。
  app.enableCors({ origin: true });
  // T-001 以图搜图的 base64 可能较大，单独放宽 JSON 上限。
  app.useBodyParser("json", { limit: "10mb" });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  console.log(`✔ WeaveOrder API → http://localhost:${env.PORT}/api/health`);
}

void bootstrap();
