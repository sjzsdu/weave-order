import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  FeatureFlagInput,
  PlatformConfig,
  PlatformConfigInput,
  PlatformIdentitySettings,
  PlatformLlmSettings,
  PlatformLlmSettingsInput,
  IdentitySettingsInput,
} from "@weave-order/schema";
import {
  featureFlags,
  identitySettings,
  llmSettings,
  platformConfigs,
  subscriptions,
  tenants,
  usageDaily,
} from "@weave-order/control-db";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import type { PlatformActor } from "../auth/auth.service";
import { conflict, forbidden, invalid, notFound } from "../domain/errors";
import { AuditService } from "./audit.service";
import { currentMonthPeriod, toJson } from "./util";

/**
 * 密钥引用白名单：只接受 LiteLLM 约定的密钥变量名
 * （`LITELLM_MASTER_KEY` / `LITELLM_TENANT_KEY_*`，见 `.env` 与 docs/track-b-agents.md）。
 *
 * 其它任何名字（`DATABASE_URL`、`CASDOOR_*_SECRET`…）一律拒绝：
 * 绝不执行 `process.env[用户输入]`，否则最低权限账号可以把控制面进程的全部密钥发到任意地址。
 * 租户端 `apps/api/src/platform/llm.ts` 用同一规则（两包不共享源码，改一处须同步另一处）。
 */
export const LLM_KEY_REF_PATTERN = /^LITELLM_(MASTER|TENANT)_KEY(?:_[A-Za-z0-9]+)*$/;

export function isAllowedLlmKeyRef(name: string): boolean {
  return LLM_KEY_REF_PATTERN.test(name);
}

/** 只接受 http(s) 地址，返回 origin（协议://主机[:端口]），用于白名单比较。 */
function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** 逗号分隔的地址列表（环境变量）逐项取 origin。 */
function originsOfList(value: string | undefined): string[] {
  if (!value) return [];
  const origins: string[] = [];
  for (const part of value.split(",")) {
    const origin = originOf(part.trim());
    if (origin) origins.push(origin);
  }
  return origins;
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: PlatformDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* ------------------------------- LLM ------------------------------- */

  async getLlm(): Promise<{ global: PlatformLlmSettings; overrides: PlatformLlmSettings[] }> {
    const globalRows = await this.db
      .select()
      .from(llmSettings)
      .where(and(eq(llmSettings.scope, "GLOBAL"), isNull(llmSettings.tenantId)))
      .limit(1);
    const overrides = await this.db
      .select()
      .from(llmSettings)
      .where(eq(llmSettings.scope, "TENANT"))
      .orderBy(desc(llmSettings.updatedAt));
    return {
      global: mapLlm(globalRows[0]),
      overrides: overrides.map((row) => mapLlm(row)),
    };
  }

  async upsertLlm(actor: PlatformActor, raw: unknown): Promise<PlatformLlmSettings> {
    const input = PlatformLlmSettingsInput.parse(raw);
    if (input.scope === "TENANT" && !input.tenantId) {
      throw conflict("租户覆盖必须指定 tenantId");
    }
    const scope = input.scope;
    const tenantId = scope === "TENANT" ? (input.tenantId ?? null) : null;
    const whereScope = and(
      eq(llmSettings.scope, scope),
      tenantId ? eq(llmSettings.tenantId, tenantId) : isNull(llmSettings.tenantId),
    );
    const existing = await this.db.select().from(llmSettings).where(whereScope).limit(1);
    const current = existing[0];
    const now = new Date();
    const values = {
      provider: input.provider ?? current?.provider ?? "litellm",
      baseUrl: input.baseUrl ?? current?.baseUrl ?? null,
      defaultModel: input.defaultModel ?? current?.defaultModel ?? "deepseek-chat",
      dailyTokenBudget:
        input.dailyTokenBudget !== undefined
          ? input.dailyTokenBudget
          : (current?.dailyTokenBudget ?? null),
      monthlyTokenBudget:
        input.monthlyTokenBudget !== undefined
          ? input.monthlyTokenBudget
          : (current?.monthlyTokenBudget ?? null),
      keyRef: input.keyRef ?? current?.keyRef ?? null,
      allowExternal: input.allowExternal ?? current?.allowExternal ?? true,
      version: (current?.version ?? 0) + 1,
      updatedBy: actor.sub,
      updatedAt: now,
    };

    const rows = current
      ? await this.db.update(llmSettings).set(values).where(whereScope).returning()
      : await this.db
          .insert(llmSettings)
          .values({ scope, tenantId, ...values })
          .returning();
    const row = rows[0];
    if (!row) throw new Error("LLM 设置写入失败");

    await this.audit.record(actor, {
      action: "LLM_SETTINGS_UPDATED",
      targetType: "llm_settings",
      targetId: tenantId ?? "global",
      before: current ? toJson(current) : null,
      after: toJson(row),
      reason: "更新 LLM 配置",
    });
    return mapLlm(row);
  }

  /**
   * 测试连接：只验证可达性，不发送业务数据、不记录 Key。
   *
   * 安全约束（WAN-94）：
   * - 目标地址只能来自服务端配置：`llm_settings` 已保存的行、`LITELLM_BASE_URL`
   *   或运维显式放行的 `LLM_ALLOWED_BASE_URLS`，白名单外一律 403；
   * - `keyRef` 必须命中受控枚举，禁止 `process.env[用户输入]`，否则 403（不发出任何出网请求）；
   * - 每次尝试（含被拒绝的）都写审计：谁、目标地址、命中与否，不含密钥。
   */
  async testLlm(
    actor: PlatformActor,
    input: { baseUrl?: unknown; keyRef?: unknown } = {},
  ): Promise<{
    ok: boolean;
    status: number | null;
    latencyMs: number;
    message: string;
  }> {
    if (input.baseUrl !== undefined && typeof input.baseUrl !== "string") {
      throw invalid("baseUrl 必须是字符串");
    }
    if (input.keyRef !== undefined && typeof input.keyRef !== "string") {
      throw invalid("keyRef 必须是字符串");
    }
    const baseUrl = input.baseUrl;
    const keyRef = input.keyRef;

    if (keyRef !== undefined && !isAllowedLlmKeyRef(keyRef)) {
      await this.recordLlmTest(actor, baseUrl?.slice(0, 128) ?? null, {
        ok: false,
        status: null,
        latencyMs: 0,
        message: `keyRef 不在白名单内，未发起请求`,
      });
      throw forbidden(
        `keyRef "${keyRef.slice(0, 128)}" 不在白名单内（只允许 LITELLM_MASTER_KEY / LITELLM_TENANT_KEY_*）`,
      );
    }

    const rows = await this.db.select().from(llmSettings);
    const globalRow = rows.find((row) => row.scope === "GLOBAL" && row.tenantId === null);
    const allowedOrigins = new Set<string>();
    for (const row of rows) {
      const origin = row.baseUrl ? originOf(row.baseUrl) : null;
      if (origin) allowedOrigins.add(origin);
    }
    for (const origin of [
      ...originsOfList(process.env.LITELLM_BASE_URL),
      ...originsOfList(process.env.LLM_ALLOWED_BASE_URLS),
    ]) {
      allowedOrigins.add(origin);
    }

    const requested = (baseUrl ?? globalRow?.baseUrl ?? process.env.LITELLM_BASE_URL ?? "").replace(
      /\/+$/,
      "",
    );

    if (baseUrl) {
      const origin = originOf(baseUrl);
      if (!origin || !allowedOrigins.has(origin)) {
        await this.recordLlmTest(actor, baseUrl.slice(0, 128), {
          ok: false,
          status: null,
          latencyMs: 0,
          message: "目标地址不在白名单内，未发起请求",
        });
        throw forbidden(
          "测试目标地址不在白名单内（仅允许 llm_settings 已配置地址 / LITELLM_BASE_URL / LLM_ALLOWED_BASE_URLS）",
        );
      }
    }

    if (!requested)
      return { ok: false, status: null, latencyMs: 0, message: "未配置 LLM 网关地址" };
    const key = keyRef ? process.env[keyRef] : process.env.LITELLM_MASTER_KEY;
    const started = Date.now();
    try {
      const response = await fetch(`${requested}/health/liveliness`, {
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
        signal: AbortSignal.timeout(4000),
      });
      const result = {
        ok: response.ok,
        status: response.status,
        latencyMs: Date.now() - started,
        message: response.ok ? "网关可达" : `网关返回 ${response.status}`,
      };
      await this.recordLlmTest(actor, requested.slice(0, 128), result);
      return result;
    } catch (cause) {
      // 底层错误（fetch failed / ENOTFOUND）只写日志与审计，页面文案保持中文可读。
      console.error("[platform-api] LLM 网关探测失败", {
        target: requested.slice(0, 128),
        message: cause instanceof Error ? cause.message : String(cause),
      });
      const result = {
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        message: "网关不可达，请检查网关地址、白名单与网络",
      };
      await this.recordLlmTest(actor, requested.slice(0, 128), result);
      return result;
    }
  }

  /** 连通性测试审计：记录谁、目标地址、命中与否；绝不记录密钥本身。 */
  private async recordLlmTest(
    actor: PlatformActor,
    targetId: string | null,
    outcome: { ok: boolean; status: number | null; latencyMs: number; message: string },
  ): Promise<void> {
    await this.audit.record(actor, {
      action: "LLM_GATEWAY_TESTED",
      targetType: "llm_gateway",
      targetId,
      after: outcome,
      reason: "LLM 网关连通性测试",
    });
  }

  async llmStats() {
    const period = `${currentMonthPeriod()}-01`;
    const rows = await this.db
      .select({
        tenantId: usageDaily.tenantId,
        tenantName: tenants.name,
        inputTokens: sql<string>`coalesce(sum(${usageDaily.llmInputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${usageDaily.llmOutputTokens}), 0)`,
        costCents: sql<string>`coalesce(sum(${usageDaily.llmCostCents}), 0)`,
      })
      .from(usageDaily)
      .innerJoin(tenants, eq(tenants.id, usageDaily.tenantId))
      .where(gte(usageDaily.day, period))
      .groupBy(usageDaily.tenantId, tenants.name)
      .orderBy(desc(sql`sum(${usageDaily.llmCostCents})`));
    return {
      period: currentMonthPeriod(),
      rows: rows.map((row) => ({
        tenantId: row.tenantId,
        tenantName: row.tenantName,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        costCents: Number(row.costCents),
      })),
      totalCostCents: rows.reduce((sum, row) => sum + Number(row.costCents), 0),
    };
  }

  /* --------------------------- 功能开关 --------------------------- */

  async listFlags() {
    const rows = await this.db.select().from(featureFlags).orderBy(featureFlags.key);
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      rolloutPercent: row.rolloutPercent,
      tenantIds: row.tenantIds,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async createFlag(actor: PlatformActor, raw: unknown) {
    const input = FeatureFlagInput.parse(raw);
    const key = (raw as { key?: unknown }).key;
    const name = (raw as { name?: unknown }).name;
    if (typeof key !== "string" || typeof name !== "string") {
      throw conflict("创建开关需要 key 与 name");
    }
    const rows = await this.db
      .insert(featureFlags)
      .values({
        key,
        name,
        description:
          typeof (raw as { description?: unknown }).description === "string"
            ? (raw as { description: string }).description
            : "",
        enabled: input.enabled ?? false,
        rolloutPercent: input.rolloutPercent ?? 0,
        tenantIds: input.tenantIds ?? [],
        updatedBy: actor.sub,
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    if (!row) throw conflict("功能开关已存在");
    await this.audit.record(actor, {
      action: "FEATURE_FLAG_CREATED",
      targetType: "feature_flag",
      targetId: key,
      after: toJson(row),
      reason: "创建功能开关",
    });
    return row;
  }

  async updateFlag(actor: PlatformActor, key: string, raw: unknown) {
    const input = FeatureFlagInput.parse(raw);
    const current = await this.db
      .select()
      .from(featureFlags)
      .where(eq(featureFlags.key, key))
      .limit(1);
    if (!current[0]) throw notFound("功能开关不存在");
    const rows = await this.db
      .update(featureFlags)
      .set({
        enabled: input.enabled ?? current[0].enabled,
        rolloutPercent: input.rolloutPercent ?? current[0].rolloutPercent,
        tenantIds: input.tenantIds ?? current[0].tenantIds,
        updatedBy: actor.sub,
        updatedAt: new Date(),
      })
      .where(eq(featureFlags.key, key))
      .returning();
    await this.audit.record(actor, {
      action: "FEATURE_FLAG_UPDATED",
      targetType: "feature_flag",
      targetId: key,
      before: toJson(current[0]),
      after: toJson(rows[0]),
      reason: "调整灰度",
    });
    return rows[0];
  }

  /* --------------------------- 配置中心 --------------------------- */

  async listConfigs(): Promise<PlatformConfig[]> {
    const rows = await this.db
      .select()
      .from(platformConfigs)
      .where(eq(platformConfigs.status, "ACTIVE"))
      .orderBy(platformConfigs.key);
    return rows.map(mapConfig);
  }

  async configHistory(key: string): Promise<PlatformConfig[]> {
    const rows = await this.db
      .select()
      .from(platformConfigs)
      .where(eq(platformConfigs.key, key))
      .orderBy(desc(platformConfigs.version));
    return rows.map(mapConfig);
  }

  async configPreview(raw: unknown) {
    const input = PlatformConfigInput.parse(raw);
    const scopeRef = input.scopeRef ?? null;
    const current = await this.db
      .select()
      .from(platformConfigs)
      .where(
        and(
          eq(platformConfigs.key, input.key),
          eq(platformConfigs.scope, input.scope),
          scopeRef ? eq(platformConfigs.scopeRef, scopeRef) : isNull(platformConfigs.scopeRef),
          eq(platformConfigs.status, "ACTIVE"),
        ),
      )
      .limit(1);
    const affected = await this.affectedTenants(input.scope, scopeRef);
    return {
      key: input.key,
      scope: input.scope,
      scopeRef,
      before: current[0]?.value ?? null,
      after: input.value,
      affectedTenants: affected,
      changed: JSON.stringify(current[0]?.value ?? null) !== JSON.stringify(input.value),
    };
  }

  async saveConfig(actor: PlatformActor, raw: unknown): Promise<PlatformConfig> {
    const input = PlatformConfigInput.parse(raw);
    if (input.scope !== "GLOBAL" && !input.scopeRef) {
      throw conflict("套餐/租户作用域必须指定 scopeRef");
    }
    const scopeRef = input.scope === "GLOBAL" ? null : (input.scopeRef ?? null);
    const whereScope = and(
      eq(platformConfigs.key, input.key),
      eq(platformConfigs.scope, input.scope),
      scopeRef ? eq(platformConfigs.scopeRef, scopeRef) : isNull(platformConfigs.scopeRef),
    );
    const latest = await this.db
      .select({ version: platformConfigs.version })
      .from(platformConfigs)
      .where(whereScope)
      .orderBy(desc(platformConfigs.version))
      .limit(1);
    const version = (latest[0]?.version ?? 0) + 1;

    const row = await this.db.transaction(async (tx) => {
      await tx.update(platformConfigs).set({ status: "SUPERSEDED" }).where(whereScope);
      const rows = await tx
        .insert(platformConfigs)
        .values({
          key: input.key,
          scope: input.scope,
          scopeRef,
          value: input.value,
          version,
          status: "ACTIVE",
          createdBy: actor.sub,
        })
        .returning();
      return rows[0];
    });
    if (!row) throw new Error("配置写入失败");
    await this.audit.record(actor, {
      action: "PLATFORM_CONFIG_SAVED",
      targetType: "platform_config",
      targetId: row.id,
      after: { key: input.key, scope: input.scope, scopeRef, value: input.value, version },
      reason: "配置中心发布新版本",
    });
    return mapConfig(row);
  }

  async rollbackConfig(actor: PlatformActor, id: string): Promise<PlatformConfig> {
    const rows = await this.db
      .select()
      .from(platformConfigs)
      .where(eq(platformConfigs.id, id))
      .limit(1);
    const target = rows[0];
    if (!target) throw notFound("配置版本不存在");
    return this.saveConfig(actor, {
      key: target.key,
      scope: target.scope,
      scopeRef: target.scopeRef,
      value: target.value,
    });
  }

  /* ----------------------------- 身份 ----------------------------- */

  async getIdentity(): Promise<{
    settings: PlatformIdentitySettings;
    organizations: { tenantId: string; tenantName: string; slug: string; casdoorOrg: string }[];
  }> {
    await this.db.insert(identitySettings).values({ id: "default" }).onConflictDoNothing();
    const rows = await this.db
      .select()
      .from(identitySettings)
      .where(eq(identitySettings.id, "default"))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("身份设置缺失");
    const tenantRows = await this.db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
      .from(tenants);
    return {
      settings: {
        mfaRequired: row.mfaRequired,
        socialLoginAllowed: row.socialLoginAllowed,
        ssoEnabled: row.ssoEnabled,
        casdoorOrgTemplate: row.casdoorOrgTemplate,
        sessionMaxHours: row.sessionMaxHours,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt.toISOString(),
      },
      organizations: tenantRows.map((tenant) => ({
        tenantId: tenant.id,
        tenantName: tenant.name,
        slug: tenant.slug,
        casdoorOrg: row.casdoorOrgTemplate.replace("{slug}", tenant.slug),
      })),
    };
  }

  async updateIdentity(actor: PlatformActor, raw: unknown): Promise<PlatformIdentitySettings> {
    const input = IdentitySettingsInput.parse(raw);
    const before = await this.getIdentity();
    const rows = await this.db
      .update(identitySettings)
      .set({
        mfaRequired: input.mfaRequired ?? before.settings.mfaRequired,
        ssoEnabled: input.ssoEnabled ?? before.settings.ssoEnabled,
        casdoorOrgTemplate: input.casdoorOrgTemplate ?? before.settings.casdoorOrgTemplate,
        sessionMaxHours: input.sessionMaxHours ?? before.settings.sessionMaxHours,
        updatedBy: actor.sub,
        updatedAt: new Date(),
      })
      .where(eq(identitySettings.id, "default"))
      .returning();
    await this.audit.record(actor, {
      action: "IDENTITY_SETTINGS_UPDATED",
      targetType: "identity_settings",
      targetId: "default",
      before: toJson(before.settings),
      after: toJson(rows[0]),
      reason: "更新身份与 MFA 策略",
    });
    return (await this.getIdentity()).settings;
  }

  private async affectedTenants(scope: string, scopeRef: string | null): Promise<number> {
    if (scope === "TENANT") return scopeRef ? 1 : 0;
    if (scope === "PLAN") {
      const rows = scopeRef
        ? await this.db
            .select({ count: sql<string>`count(*)` })
            .from(subscriptions)
            .where(eq(subscriptions.planCode, scopeRef))
        : [];
      return rows[0] ? Number(rows[0].count) : 0;
    }
    const rows = await this.db.select({ count: sql<string>`count(*)` }).from(tenants);
    return Number(rows[0]?.count ?? 0);
  }
}

function mapLlm(row: typeof llmSettings.$inferSelect | undefined): PlatformLlmSettings {
  if (!row) {
    return {
      scope: "GLOBAL",
      tenantId: null,
      provider: "litellm",
      baseUrl: null,
      defaultModel: "deepseek-chat",
      dailyTokenBudget: null,
      monthlyTokenBudget: null,
      keyRef: null,
      allowExternal: true,
      version: 0,
      updatedBy: null,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    scope: row.scope,
    tenantId: row.tenantId,
    provider: row.provider,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    dailyTokenBudget: row.dailyTokenBudget,
    monthlyTokenBudget: row.monthlyTokenBudget,
    keyRef: row.keyRef,
    allowExternal: row.allowExternal,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapConfig(row: typeof platformConfigs.$inferSelect): PlatformConfig {
  return {
    id: row.id,
    key: row.key,
    scope: row.scope,
    scopeRef: row.scopeRef,
    value: row.value,
    version: row.version,
    status: row.status,
    effectiveFrom: row.effectiveFrom.toISOString(),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}
