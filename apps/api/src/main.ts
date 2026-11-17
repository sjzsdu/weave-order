import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { AppDatabaseProvider } from "./platform/database.provider";
import { SchemaReadinessProbe } from "./platform/schema-readiness";
import { createImageEmbeddingProviderFromEnv } from "./platform/embedding";
import { loadEnv } from "./platform/env";
import { ImageIndexWorker, setImageIndexWorker } from "./platform/image-index-worker";
import { createObjectStorageFromEnv } from "./platform/storage";

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
  // 图像索引后台队列：confirm / 建样品只入队，HTTP 响应不等模型。
  // 用业务连接池 + `withTenantSession`，因此每个任务都在正确的 RLS 租户上下文里执行。
  const appDatabase = app.get(AppDatabaseProvider);
  // 数据库结构校验：漏跑迁移时在启动日志里说清楚，而不是等用户撞上 500。
  // 容器在 `listen` 之前就要有结论，所以放在起 HTTP 之前。
  await app.get(SchemaReadinessProbe).assertAtBoot(env.WEAVE_REQUIRE_SCHEMA_AT_BOOT);
  const worker = new ImageIndexWorker(
    appDatabase.pool,
    createImageEmbeddingProviderFromEnv(env, process.env.DASHSCOPE_API_KEY),
    createObjectStorageFromEnv(env),
    { logger: (message) => console.warn(message), maxEdge: env.IMAGE_EMBEDDING_MAX_EDGE },
  );
  setImageIndexWorker(worker);
  // 页面与 API 同机开发（Vite 5173 -> API 3000），允许跨端口调用。
  app.enableCors({ origin: true });
  // T-001 以图搜图的 base64 可能较大，单独放宽 JSON 上限。
  app.useBodyParser("json", { limit: "10mb" });
  app.enableShutdownHooks();
  // 关闭时先把队列跑完（最多 5s）：剩下的行仍是 pending，下次该租户活跃时补漏。
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void worker.stop();
    });
  }
  // 必须在启动 HTTP 服务后再打印就绪：S4 收敛时这行被误删，
  // 进程只初始化 Nest 就退出，所有 HTTP 验收（含 S1 media e2e）都会假失败。
  await app.listen(env.PORT);
  console.log(
    `✔ WeaveOrder API → http://localhost:${env.PORT}/api/health（auth=${env.AUTH_MODE}）`,
  );
}

void bootstrap().catch((error: unknown) => {
  // 启动失败必须真的退出：连接池与 Nest 容器还开着，只打印错误会让容器「日志里有错、
  // 进程还在跑」，编排器永远等不到一次明确的失败（WEAVE_REQUIRE_SCHEMA_AT_BOOT 依赖这点）。
  console.error("✖ API 启动失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
