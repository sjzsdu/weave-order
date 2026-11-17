import { eq, inArray } from "drizzle-orm";
import { controlSyncOutbox, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";

/**
 * 双库一致性对账（三道防线的第三道，兜底）。
 *
 * 权威源 = 业务库：每个 ACTIVE/TRIAL 租户，控制面必须有同 slug 记录。
 * - 业务库有、控制面无 → 自动补登（调控制面 internal/tenants，幂等）+ 补写 outbox；
 * - 控制面有、业务库无 → 只报告，绝不自动删（可能是运营手工建的合法记录）。
 *
 * 分层：TenantSource / ControlPlane 是窄接口，单测用内存实现；runReconcileOnce 是纯逻辑。
 */

export interface SyncTenant {
  tenantId: string;
  slug: string;
  name: string;
  ownerEmail: string | null;
}

export interface TenantSource {
  /** 业务库所有需要出现在控制面的租户（ACTIVE/TRIAL），含创建时登记的联系人邮箱。 */
  listAuthoritativeTenants(): Promise<SyncTenant[]>;
  /** 确保这些租户都有 outbox 行（对账补写，便于 worker 也纳入可靠投递）。 */
  ensureOutbox(rows: SyncTenant[]): Promise<void>;
}

export interface ControlPlane {
  /** 控制面已知的所有租户 slug。 */
  listSlugs(): Promise<Set<string>>;
  /** 补登一条试用租户（幂等）。 */
  register(row: SyncTenant): Promise<void>;
}

export interface ReconcileResult {
  authoritative: number;
  inControlPlane: number;
  repaired: number;
  /** 控制面有、业务库无：只报告不删。 */
  extraInControlPlane: string[];
}

/**
 * 跑一轮对账。返回差异与补登数量；调用方据 repaired>0 或 extra 非空决定告警。
 */
export async function runReconcileOnce(
  source: TenantSource,
  control: ControlPlane,
): Promise<ReconcileResult> {
  const authoritative = await source.listAuthoritativeTenants();
  const controlSlugs = await control.listSlugs();
  const authSlugs = new Set(authoritative.map((t) => t.slug));

  const missing = authoritative.filter((t) => !controlSlugs.has(t.slug));
  for (const row of missing) {
    await control.register(row);
  }
  // 无论是否缺失，确保 outbox 有账——让投递 worker 也能覆盖未来变更与重试。
  await source.ensureOutbox(authoritative);

  const extra = [...controlSlugs].filter((slug) => !authSlugs.has(slug)).sort();
  return {
    authoritative: authoritative.length,
    inControlPlane: controlSlugs.size,
    repaired: missing.length,
    extraInControlPlane: extra,
  };
}

/** 真实 TenantSource：用 owner 连接读业务库；outbox 补写用 onConflictDoNothing 幂等。 */
export function createDrizzleTenantSource(db: Db): TenantSource {
  return {
    async listAuthoritativeTenants() {
      const rows = await db
        .select({
          tenantId: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          ownerEmail: controlSyncOutbox.ownerEmail,
        })
        .from(tenants)
        .leftJoin(controlSyncOutbox, eq(controlSyncOutbox.tenantId, tenants.id))
        .where(inArray(tenants.status, ["ACTIVE", "TRIAL"]));
      // 同一 slug 理论上唯一；leftJoin 后理论上也唯一，保险去重。
      const seen = new Set<string>();
      return rows.filter((row) => {
        if (seen.has(row.slug)) return false;
        seen.add(row.slug);
        return true;
      });
    },
    async ensureOutbox(rows) {
      if (rows.length === 0) return;
      await db
        .insert(controlSyncOutbox)
        .values(
          rows.map((row) => ({
            tenantId: row.tenantId,
            slug: row.slug,
            name: row.name,
            ownerEmail: row.ownerEmail,
          })),
        )
        .onConflictDoNothing({ target: controlSyncOutbox.slug });
    },
  };
}

/**
 * 真实 ControlPlane：调 platform-api 内部接口（共享密钥）。
 */
export function createHttpControlPlane(options: {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ControlPlane {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const headers = { "Content-Type": "application/json", "x-weave-internal": options.secret };
  const timeout = options.timeoutMs ?? 8000;
  return {
    async listSlugs() {
      const response = await doFetch(`${base}/platform/api/internal/tenants/slugs`, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`读取控制面 slug 失败 ${response.status}`);
      const body = (await response.json()) as { slugs: { slug: string }[] };
      return new Set(body.slugs.map((s) => s.slug));
    },
    async register(row) {
      const response = await doFetch(`${base}/platform/api/internal/tenants`, {
        method: "POST",
        headers,
        body: JSON.stringify({ slug: row.slug, name: row.name, ownerEmail: row.ownerEmail }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`对账补登失败 ${response.status}：${row.slug}`);
    },
  };
}
