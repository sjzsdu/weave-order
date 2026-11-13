import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { GatewayModule } from "./gateway/gateway.module";
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
  providers: [PrintAgentScopeMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(PrintAgentScopeMiddleware).forRoutes("*");
  }
}
