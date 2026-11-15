import { Module } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { isProductionLike } from "../platform/runtime-mode";
import { DevPersonasController } from "./personas.controller";

/**
 * 是否装配 dev persona 路由。
 *
 * 与 `loadEnv()` 的默认值对齐：`AUTH_MODE` 缺省为 dev，因此本地不带 .env 也能用；
 * 只要进入生产态（NODE_ENV=production 或 AUTH_MODE=oidc），或者显式选了 oidc，
 * 整个模块就不进 imports —— 路由不存在，客户端拿到 404，而不是靠 403 挡。
 */
export function devPersonasEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  if (isProductionLike(source)) return false;
  return (source.AUTH_MODE ?? "dev") === "dev";
}

@Module({
  imports: [GatewayModule],
  controllers: [DevPersonasController],
})
export class DevModule {}
