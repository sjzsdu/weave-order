import { Inject, Injectable, Logger } from "@nestjs/common";
import { getTableName, is, Table } from "drizzle-orm";
import * as dbSchema from "@weave-order/db";
import { AppDatabaseProvider } from "./database.provider";

/**
 * 数据库结构就绪探针。
 *
 * 为什么需要它：镜像和数据库是两条独立的发布轨道。COMPOSE 里漏跑 `migrate`
 * 时，进程照常启动、健康检查照常 200，只有碰到新表的那条查询 500——
 * 2026-11-17 生产「说点什么」整条链路不可用就是这么发生的，而且没人从
 * `/api/health` 看出来。
 *
 * 期望的表以 Drizzle schema 为唯一事实源：以后新增表自动纳入检查，
 * 不需要维护第二份名单。
 */
export const EXPECTED_TABLES: readonly string[] = Object.values(dbSchema)
  .flatMap((value) => (is(value, Table) ? [String(getTableName(value))] : []))
  .sort();

/** 探针会被每次健康检查打到，结果缓存一小会儿；部署窗口内仍能秒级反映真实状态。 */
const CACHE_MS = 15_000;

export interface SchemaReadiness {
  /** 期望的表全部存在。 */
  ok: boolean;
  /** 缺失的表名（最多列 20 个，够定位是哪一批迁移没跑）。 */
  missing: string[];
  /** 检查本身失败（连不上库等）时的原因；含义是「未知」，不是「正常」。 */
  error?: string;
  checkedAt: string;
}

@Injectable()
export class SchemaReadinessProbe {
  private readonly logger = new Logger(SchemaReadinessProbe.name);
  private cached: { at: number; value: SchemaReadiness } | null = null;

  // esbuild（tsx dev）不生成 decorator metadata，与仓储其余手写 provider 一致：
  // 构造参数一律显式 @Inject，不依赖运行时反射。
  constructor(@Inject(AppDatabaseProvider) private readonly appDatabase: AppDatabaseProvider) {}

  async check(force = false): Promise<SchemaReadiness> {
    if (!force && this.cached && Date.now() - this.cached.at < CACHE_MS) {
      return this.cached.value;
    }

    let value: SchemaReadiness;
    try {
      const { rows } = await this.appDatabase.pool.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [EXPECTED_TABLES],
      );
      const present = new Set(rows.map((row) => row.relname));
      const missing = EXPECTED_TABLES.filter((name) => !present.has(name));
      value = {
        ok: missing.length === 0,
        missing: missing.slice(0, 20),
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      // 检查失败 ≠ 结构正常：显式标成未知，别把「查不到」当成「没问题」。
      const message = error instanceof Error ? error.message : String(error);
      value = { ok: false, missing: [], error: message, checkedAt: new Date().toISOString() };
    }

    this.cached = { at: Date.now(), value };
    return value;
  }

  /**
   * 启动时打一条结论明确的日志。`WEAVE_REQUIRE_SCHEMA_AT_BOOT=1` 时直接拒绝启动：
   * 部署机上的 compose 若把 migrate 放在 api 之前，缺表就是一次「发布失败」，
   * 而不是一个悄悄坏掉的功能。
   */
  async assertAtBoot(requireSchema = false): Promise<void> {
    const readiness = await this.check(true);
    if (readiness.error) {
      this.logger.warn(`无法校验数据库结构：${readiness.error}`);
      return;
    }
    if (readiness.ok) {
      this.logger.log(`数据库结构已就绪：${EXPECTED_TABLES.length} 张表全部存在。`);
      return;
    }

    const detail =
      `数据库结构落后：缺少 ${readiness.missing.join("、")}` +
      `${readiness.missing.length > 0 ? " 等表" : "表"}。` +
      "本次发布没有执行数据库迁移，依赖这些表的接口会返回 503。" +
      "修复：在部署机执行 `pnpm --filter @weave-order/db migrate`（或 compose 的 migrate 服务）。";
    if (requireSchema) {
      throw new Error(detail);
    }
    this.logger.error(detail);
  }
}
