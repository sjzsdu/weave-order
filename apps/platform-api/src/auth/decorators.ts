import { SetMetadata } from "@nestjs/common";
import type { PlatformPermission } from "../domain/permissions";

export const PUBLIC_ROUTE = "platform:public";
export const PERMISSIONS_KEY = "platform:permissions";

/** 无鉴权路由：仅健康检查 / dev 登录入口。 */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/** 声明式权限：服务端矩阵判定，前端只做展示。 */
export const RequirePermission = (...permissions: PlatformPermission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
