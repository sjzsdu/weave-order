import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PlatformPermission } from "../domain/permissions";
import { forbidden } from "../domain/errors";
import { AuthService } from "./auth.service";
import type { PlatformRequest } from "./auth.service";
import { PERMISSIONS_KEY, PUBLIC_ROUTE } from "./decorators";

@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<PlatformRequest>();
    const header = request.headers.authorization;
    const actor = await this.auth.authenticate(Array.isArray(header) ? header[0] : header);
    request.platformActor = actor;

    const required =
      this.reflector.getAllAndOverride<PlatformPermission[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    for (const permission of required) {
      if (!actor.permissions.includes(permission)) {
        throw forbidden(`角色 ${actor.role} 缺少权限 ${permission}`);
      }
    }
    return true;
  }
}
