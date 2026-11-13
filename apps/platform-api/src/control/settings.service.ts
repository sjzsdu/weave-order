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
import { conflict, notFound } from "../domain/errors";
import { AuditService } from "./audit.service";
import { currentMonthPeriod, toJson } from "./util";

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

  /** 测试连接：只验证可达性，不发送业务数据、不记录 Key。 */
  async testLlm(
    baseUrl?: string,
    keyRef?: string,
  ): Promise<{
    ok: boolean;
    status: number | null;
    latencyMs: number;
    message: string;
  }> {
    const globalRows = await this.db
      .select()
      .from(llmSettings)
      .where(and(eq(llmSettings.scope, "GLOBAL"), isNull(llmSettings.tenantId)))
      .limit(1);
    const url = (baseUrl ?? globalRows[0]?.baseUrl ?? process.env.LITELLM_BASE_URL ?? "").replace(
      /\/$/,
      "",
    );
    if (!url) return { ok: false, status: null, latencyMs: 0, message: "未配置 LLM 网关地址" };
    const key = keyRef ? process.env[keyRef] : process.env.LITELLM_MASTER_KEY;
    const started = Date.now();
    try {
      const response = await fetch(`${url}/health/liveliness`, {
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
        signal: AbortSignal.timeout(4000),
      });
      return {
        ok: response.ok,
        status: response.status,
        latencyMs: Date.now() - started,
        message: response.ok ? "网关可达" : `网关返回 ${response.status}`,
      };
    } catch (cause) {
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        message: cause instanceof Error ? cause.message : "连接失败",
      };
    }
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
