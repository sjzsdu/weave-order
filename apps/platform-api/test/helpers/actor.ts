import type { PlatformRole } from "@weave-order/schema";
import type { PlatformActor } from "../../src/auth/auth.service";
import { permissionsFor } from "../../src/domain/permissions";

/** 测试用 actor：不经过 HTTP guard，只验证 service 层权限与双人复核规则。 */
export function AccountExecutor(subject: string, role: PlatformRole): PlatformActor {
  return {
    id: subject,
    sub: subject,
    name: subject,
    email: `${subject}@test.local`,
    role,
    permissions: permissionsFor(role),
  };
}
