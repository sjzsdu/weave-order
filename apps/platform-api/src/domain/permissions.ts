import type { PlatformRole } from "@weave-order/schema";

/**
 * 平台权限矩阵（服务端唯一判定；前端只拿 /auth/me 的 allowed 列表做展示）。
 * 角色最小 5 个，禁止在控制器里写 `if (role === 'owner')` 之类散装判断。
 */
export const PLATFORM_PERMISSIONS = [
  "overview:read",
  "tenant:read",
  "tenant:write",
  "tenant:status",
  "tenant:purge",
  "billing:read",
  "billing:write",
  "invoice:issue",
  "invoice:void",
  "invoice:refund",
  "usage:read",
  "usage:write",
  "pricing:read",
  "pricing:write",
  "settings:read",
  "settings:write",
  "llm:write",
  "flag:write",
  "config:write",
  "identity:write",
  "support:read",
  "support:write",
  "breakglass:request",
  "breakglass:approve",
  "audit:read",
  "approval:read",
  "approval:decide",
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

const READ_ONLY: PlatformPermission[] = [
  "overview:read",
  "tenant:read",
  "billing:read",
  "usage:read",
  "pricing:read",
  "settings:read",
  "support:read",
  "audit:read",
  "approval:read",
];

const MATRIX: Record<PlatformRole, readonly PlatformPermission[]> = {
  platform_owner: PLATFORM_PERMISSIONS,
  platform_finance: [
    ...READ_ONLY,
    "billing:write",
    "invoice:issue",
    "invoice:void",
    "invoice:refund",
    "pricing:write",
    "settings:write",
    "approval:decide",
  ],
  platform_support: [...READ_ONLY, "support:write", "breakglass:request"],
  platform_ops: [
    ...READ_ONLY,
    "settings:write",
    "llm:write",
    "flag:write",
    "config:write",
    "identity:write",
    "usage:write",
  ],
  platform_readonly: READ_ONLY,
};

export function permissionsFor(role: PlatformRole): readonly PlatformPermission[] {
  return MATRIX[role];
}

export function can(role: PlatformRole, permission: PlatformPermission): boolean {
  return MATRIX[role].includes(permission);
}

/** 危险动作需要哪些角色共同复核（按产品 §14.5 六条硬规则）。 */
export const APPROVAL_ROLES = {
  TENANT_PURGE: ["platform_owner"],
  TENANT_FORCE_PLAN: ["platform_owner"],
  PRICE_CHANGE: ["platform_owner", "platform_finance"],
  TAX_CHANGE: ["platform_owner", "platform_finance"],
  INVOICE_VOID: ["platform_finance"],
  BREAK_GLASS: ["platform_owner"],
} as const satisfies Record<string, readonly PlatformRole[]>;
