import { Module, NestModule } from "@nestjs/common";
import type { MiddlewareConsumer, Provider } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { GatewayModule } from "./gateway/gateway.module";
import { SessionCredentialMiddleware } from "./gateway/session-credential.middleware";
import { DevModule, devPersonasEnabled } from "./dev/dev.module";
import { HttpModule } from "./http/http.module";
import { ZodExceptionFilter } from "./http/zod-exception.filter";
import { DatabaseModule } from "./platform/database.module";
import { PrintAgentScopeMiddleware } from "./print/print-scope.middleware";

/**
 * 组合根：连接池 → 内核 / 工具 / 审批 → HTTP。
 * 网关是唯一把 (sub, org) 解析为 tenant 上下文的入口；HTTP 面只暴露
 * 只读目录、工具调用、人类确认与认证上下文。
 */
const providers: Provider[] = [
  PrintAgentScopeMiddleware,
  SessionCredentialMiddleware,
  // 内核裸 `.parse()` 抛出的 ZodError 统一按 400 INVALID_INPUT 回，不再冒 500。
  { provide: APP_FILTER, useClass: ZodExceptionFilter },
];

@Module({
  // dev persona 路由按环境条件注册：非 dev 模式下模块根本不进容器，路由是 404。
  imports: [
    DatabaseModule,
    HttpModule,
    GatewayModule,
    ...(devPersonasEnabled() ? [DevModule] : []),
  ],
  providers,
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 会话 Cookie 必须先归一成凭据头，后面的鉴权与业务中间件才只看一种形态。
    consumer.apply(SessionCredentialMiddleware, PrintAgentScopeMiddleware).forRoutes("*");
  }
}
