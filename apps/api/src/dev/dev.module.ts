import { Inject, Injectable, Logger, Module } from "@nestjs/common";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { DatabaseProvider } from "../platform/database.provider";
import { isProductionLike } from "../platform/runtime-mode";
import { ensureDemoIdentity } from "../kernel/demo-identity";
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

/**
 * 本地 dev 启动时按 persona 目录幂等补齐 7 个演示成员。
 *
 * 身份条只读 persona 目录，不读库，所以「目录有 7 个、库里只有 owner/sales」
 * 的老开发库会一进去点什么角色都报「权限已被收回」。这里在监听端口前把
 * membership 校正到与目录一致，避免要求开发者手动跑 seed。
 *
 * 失败只告警不阻塞启动：库还没迁移 / 连不上时，API 本身仍要能起来报错。
 */
@Injectable()
export class DemoIdentityBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(DemoIdentityBootstrap.name);

  // tsx（esbuild）不产出 design:paramtypes，必须显式 @Inject，否则依赖是 undefined。
  constructor(@Inject(DatabaseProvider) private readonly database: DatabaseProvider) {}

  async onApplicationBootstrap(): Promise<void> {
    // 测试进程并行启动、各用临时库，select-then-insert 可能撞唯一索引；
    // 测试自己需要人设时会显式 ensureDemoIdentity，这里不参与。
    if (process.env.NODE_ENV === "test") return;
    try {
      const identity = await ensureDemoIdentity(this.database.handle.db);
      this.logger.log(`演示身份已就绪（租户 ${identity.tenantId}）`);
    } catch (error) {
      this.logger.warn(
        `演示身份 seed 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

@Module({
  imports: [GatewayModule],
  controllers: [DevPersonasController],
  providers: [DemoIdentityBootstrap],
})
export class DevModule {}

