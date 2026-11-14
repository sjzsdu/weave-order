import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { GatewayModule } from "./gateway/gateway.module";
import { SessionCredentialMiddleware } from "./gateway/session-credential.middleware";
import { HttpModule } from "./http/http.module";
import { DatabaseModule } from "./platform/database.module";
import { PrintAgentScopeMiddleware } from "./print/print-scope.middleware";

/**
 * 组合根：连接池 → 内核 / 工具 / 审批 → HTTP。
 * 网关是唯一把 (sub, org) 解析为 tenant 上下文的入口；HTTP 面只暴露
 * 只读目录、工具调用、人类确认与认证上下文。
 */
@Module({
  imports: [DatabaseModule, HttpModule, GatewayModule],
  providers: [PrintAgentScopeMiddleware, SessionCredentialMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 会话 Cookie 必须先归一成凭据头，后面的鉴权与业务中间件才只看一种形态。
    consumer.apply(SessionCredentialMiddleware, PrintAgentScopeMiddleware).forRoutes("*");
  }
}
