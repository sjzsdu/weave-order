import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { PlatformRole } from "@weave-order/schema";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import { platformUsers } from "@weave-order/control-db";
import { PlatformError, forbidden } from "../domain/errors";
import { permissionsFor } from "../domain/permissions";
import type { PlatformPermission } from "../domain/permissions";
import { claimsFromDevToken, createOidcVerifier } from "./claims";
import { loadEnv } from "../env";

export interface PlatformActor {
  id: string;
  sub: string;
  name: string;
  email: string;
  role: PlatformRole;
  permissions: readonly PlatformPermission[];
}

export interface PlatformRequest {
  headers: Record<string, string | string[] | undefined>;
  platformActor?: PlatformActor;
}

@Injectable()
export class AuthService {
  private readonly env = loadEnv();
  private readonly verifier =
    this.env.PLATFORM_AUTH_MODE === "dev"
      ? (token: string) => Promise.resolve(claimsFromDevToken(token))
      : createOidcVerifier(this.env);

  constructor(@Inject(PLATFORM_DATABASE) private readonly db: PlatformDb) {}

  async authenticate(header: string | undefined): Promise<PlatformActor> {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
    if (!match?.[1]) throw new PlatformError("UNAUTHENTICATED", "缺少 Bearer 令牌", 401);
    const claims = await this.verifier(match[1]);

    const rows = await this.db
      .select()
      .from(platformUsers)
      .where(eq(platformUsers.subject, claims.sub))
      .limit(1);
    const user = rows[0];
    if (!user) throw forbidden("该账号不在平台人员名册中，请联系平台 owner 开通");
    if (user.status !== "ACTIVE") throw forbidden("平台账号已停用");

    await this.db
      .update(platformUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(platformUsers.id, user.id));

    return {
      id: user.id,
      sub: user.subject,
      name: user.name,
      email: user.email,
      role: user.role,
      permissions: permissionsFor(user.role),
    };
  }
}
