import { Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { AppDatabaseProvider, DatabaseProvider } from "../platform/database.provider";
import { loadEnv } from "../platform/env";
import { createKernel } from "../kernel";
import type { Kernel } from "../kernel";
import { PersonalAccessService } from "../auth/personal-access.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { createCasdoorVerifier, createDevVerifier } from "./oidc";
import type { TokenVerifier } from "./oidc";
import { createSessionService, SessionService, TENANT_SESSIONS } from "./session.service";

export const TOKEN_VERIFIER = Symbol("TOKEN_VERIFIER");
export const DIRECTORY_KERNEL = Symbol("DIRECTORY_KERNEL");
export { TENANT_SESSIONS };

function verifierFactory(): TokenVerifier {
  const env = loadEnv();
  if (env.AUTH_MODE === "dev") {
    if (env.NODE_ENV === "production") {
      throw new Error("生产环境禁止 AUTH_MODE=dev：必须使用 Casdoor OIDC 验签");
    }
    return createDevVerifier();
  }
  return createCasdoorVerifier({
    issuer: env.CASDOOR_ISSUER,
    audience: env.CASDOOR_AUDIENCE,
    jwksUri: env.CASDOOR_JWKS_URI,
  });
}

const providers: Provider[] = [
  {
    provide: TOKEN_VERIFIER,
    useFactory: verifierFactory,
  },
  {
    // 硬约束：DIRECTORY_KERNEL 用平台/owner 连接做 membership 目录查询，
    // 永远不能拿去处理业务请求；业务请求只走 AppDatabaseProvider 的租户会话。
    provide: DIRECTORY_KERNEL,
    useFactory: (database: DatabaseProvider): Kernel => createKernel(database.handle.db),
    inject: [DatabaseProvider],
  },
  {
    // 凭据表是控制面数据，用 owner 连接（DIRECTORY_KERNEL 的 db）读写。
    provide: PersonalAccessService,
    useFactory: (directory: Kernel): PersonalAccessService =>
      new PersonalAccessService(directory.access),
    inject: [DIRECTORY_KERNEL],
  },
  {
    // 租户会话：`tenant_id` 只存在这里，前端既拿不到也传不了。
    provide: TENANT_SESSIONS,
    useFactory: (): SessionService => createSessionService().service,
  },
  {
    provide: AuthService,
    useFactory: (
      app: AppDatabaseProvider,
      verifier: TokenVerifier,
      directory: Kernel,
      personalTokens: PersonalAccessService,
      sessions: SessionService,
    ): AuthService => new AuthService(app.pool, verifier, directory, personalTokens, sessions),
    inject: [
      AppDatabaseProvider,
      TOKEN_VERIFIER,
      DIRECTORY_KERNEL,
      PersonalAccessService,
      TENANT_SESSIONS,
    ],
  },
];

@Module({
  controllers: [AuthController],
  providers,
  exports: [AuthService, PersonalAccessService, TENANT_SESSIONS],
})
export class GatewayModule {}
