import { z } from "zod";
import { DataScope, MemberRole } from "./tenancy";

/**
 * 本地 dev 的 persona 目录（WAN-136）。
 *
 * 一条 persona = 一条真实的 `memberships` 行：切换 persona 不是「前端假装换角色」，
 * 而是换一把服务端会话（`SessionService`），之后每个请求仍走
 * `resolveMembership(sub, tenantId)` 重新查库。因此：
 *
 * - seed / dev 端点 / 身份条 / e2e fixture 都只读本文件，不允许各写一份角色清单；
 * - 客户端只传 `personaKey`，从不传 role / dataScope / tenantId；
 * - 这份目录只在 `AUTH_MODE=dev` 下被装配，生产/OIDC 路由不存在。
 *
 * 团队归属是演示数据可见性的关键：经理（MANAGER + TEAM）必须与业务员
 * （SALES + OWN）在同一个 team，否则经理只能看到「本组」里没有归属人的数据，
 * 表现为切成经理后客户列表是空的。
 */

/** 稳定团队 id：没有 teams 表，teamId 只是成员行上的分组键（uuid）。 */
export const TEAM_SALES_ID = "00000000-0000-0000-0000-0000000a0001";
export const TEAM_OPS_ID = "00000000-0000-0000-0000-0000000a0002";

export const PERSONA_KEYS = [
  "owner",
  "manager",
  "sales",
  "merchandiser",
  "sample_admin",
  "finance",
  "viewer",
] as const;
export const PersonaKey = z.enum(PERSONA_KEYS);
export type PersonaKey = z.infer<typeof PersonaKey>;

/**
 * 一条演示身份。`subject` 就是 Casdoor 的 `sub`，dev 令牌形如
 * `dev:<subject>:demo`；`role` / `dataScope` / `teamId` 只用于 seed，
 * 鉴权永远以库里实际 membership 为准。
 */
export const Persona = z
  .object({
    key: PersonaKey,
    subject: z.string().min(1).max(128),
    role: MemberRole,
    dataScope: DataScope,
    teamId: z.string().uuid().nullable(),
  })
  .strict();
export type Persona = z.infer<typeof Persona>;

const RAW_PERSONAS = [
  // 老板看全量，也是演示数据的默认「全局视角」。
  { key: "owner", subject: "demo", role: "OWNER", dataScope: "ALL", teamId: null },
  // 经理与业务员同队：TEAM 范围才能覆盖业务员名下的客户/报价。
  {
    key: "manager",
    subject: "demo-manager",
    role: "MANAGER",
    dataScope: "TEAM",
    teamId: TEAM_SALES_ID,
  },
  {
    key: "sales",
    subject: "demo-sales",
    role: "SALES",
    dataScope: "OWN",
    teamId: TEAM_SALES_ID,
  },
  // 执行岗：跟单与样品管理同属业务支持组。
  {
    key: "merchandiser",
    subject: "demo-merchandiser",
    role: "MERCHANDISER",
    dataScope: "TEAM",
    teamId: TEAM_OPS_ID,
  },
  {
    key: "sample_admin",
    subject: "demo-sample-admin",
    role: "SAMPLE_ADMIN",
    dataScope: "TEAM",
    teamId: TEAM_OPS_ID,
  },
  {
    key: "finance",
    subject: "demo-finance",
    role: "FINANCE",
    dataScope: "ALL",
    teamId: null,
  },
  { key: "viewer", subject: "demo-viewer", role: "VIEWER", dataScope: "ALL", teamId: null },
] as const;

/** 唯一事实源。运行时校验一次，写错角色/范围会在 import 时直接炸。 */
export const PERSONAS: readonly Persona[] = Persona.array().parse(RAW_PERSONAS);

export function personaByKey(key: PersonaKey): Persona | null {
  return PERSONAS.find((persona) => persona.key === key) ?? null;
}

/** `GET /api/dev/personas` 的响应；只在 dev 模式下存在。 */
export const DevPersonaListResponse = z.object({ personas: z.array(Persona) }).strict();
export type DevPersonaListResponse = z.infer<typeof DevPersonaListResponse>;

/**
 * `POST /api/dev/session` 的请求体。
 *
 * `.strict()` 是验收条件的一部分：客户端只能传 personaKey。带 role 的请求
 * 会被 400 拒绝，而不是被忽略后继续切换。
 */
export const DevSessionInput = z.object({ personaKey: PersonaKey }).strict();
export type DevSessionInput = z.infer<typeof DevSessionInput>;
