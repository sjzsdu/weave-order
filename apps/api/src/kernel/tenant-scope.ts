import type { Pool } from "pg";
import { openTenantSession, withTenantSession } from "@weave-order/db";
import { createKernel } from "./index";
import type { Kernel, KernelOptions } from "./index";

/**
 * 租户会话的唯一入口（铁律 G4 + 唯一写者）。
 *
 * 网关 / 公开路由 / 打印代理都需要「借一条连接、设置 app.tenant_id、拿到内核」，
 * 但连接类型与建会话函数都属于内核的私有知识。这里把它们收在 kernel 内，
 * 对外只暴露句柄：业务层拿到的是 `kernel`，不是 `Db` / `Pool`，
 * 因此不可能绕过内核直接写业务表。
 */
export type TenantPool = Pool;

export interface KernelScope {
  kernel: Kernel;
  release(): Promise<void>;
}

type ScopeOptions = Omit<KernelOptions, "tenantId">;

/** 打开一条绑定租户的会话内核；调用方必须在 finally 里 release()。 */
export async function openKernelScope(
  pool: TenantPool,
  tenantId: string,
  options: ScopeOptions = {},
): Promise<KernelScope> {
  const session = await openTenantSession(pool, tenantId);
  return {
    kernel: createKernel(session.db, undefined, { ...options, tenantId }),
    release: () => session.release(),
  };
}

/** 同一租户会话内执行一次内核调用，自动释放连接。 */
export function withKernelScope<T>(
  pool: TenantPool,
  tenantId: string,
  fn: (kernel: Kernel) => Promise<T>,
  options: ScopeOptions = {},
): Promise<T> {
  return withTenantSession(pool, tenantId, (db) =>
    fn(createKernel(db, undefined, { ...options, tenantId })),
  );
}
