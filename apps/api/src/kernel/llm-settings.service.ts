import { llmSettings } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { LlmSettings, ResolvedLlmSettings, UpdateLlmSettingsInput } from "@weave-order/schema";
import type { JsonValue } from "@weave-order/schema";
import { and, eq, or } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";
import { loadEnv, parseModelAllowlist } from "../platform/env";

type Row = typeof llmSettings.$inferSelect;

function mapRow(row: Row): LlmSettings {
  return LlmSettings.parse({
    id: row.id,
    scope: row.scope,
    tenantId: row.tenantId,
    provider: row.provider,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    reasoningModel: row.reasoningModel,
    modelAllowlist: row.modelAllowlist,
    dailyTokenBudget: row.dailyTokenBudget,
    monthlyTokenBudget: row.monthlyTokenBudget,
    params: row.params,
    keyRef: row.keyRef,
    allowExternal: row.allowExternal,
    logPrompts: row.logPrompts,
    version: row.version,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") return {};
  return value;
}

function asStringArray(value: JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * LLM 参数解析：全局一行 + 租户一行（如有）逐字段覆盖。
 *
 * - 默认模型 / 复杂模型 / 白名单：TENANT → GLOBAL → LLM_* 环境变量。
 * - `allow_external=false` 的租户不调用外部模型，回退本地规则。
 * - `baseUrl` / `keyRef` 没配置时用通用 LLM_* 环境变量，避免把环境写进数据库。
 */
export class LlmSettingsService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async list(): Promise<LlmSettings[]> {
    const rows = await this.db
      .select()
      .from(llmSettings)
      .where(
        or(
          eq(llmSettings.scope, "GLOBAL"),
          and(eq(llmSettings.scope, "TENANT"), eq(llmSettings.tenantId, this.tenantId)),
        ),
      );
    return rows.map(mapRow);
  }

  async resolve(): Promise<ResolvedLlmSettings> {
    const env = loadEnv();
    const rows = await this.list();
    const global = rows.find((row) => row.scope === "GLOBAL");
    const tenant = rows.find((row) => row.scope === "TENANT");

    const sources: Record<string, "GLOBAL" | "TENANT" | "ENV"> = {};
    const pick = <T>(field: keyof LlmSettings, fallback: T, fromEnv = false): T => {
      if (tenant && tenant[field] !== null && tenant[field] !== undefined) {
        sources[field] = "TENANT";
        return tenant[field] as T;
      }
      if (global && global[field] !== null && global[field] !== undefined) {
        sources[field] = "GLOBAL";
        return global[field] as T;
      }
      sources[field] = fromEnv ? "ENV" : "GLOBAL";
      return fallback;
    };

    const baseUrl = tenant?.baseUrl ?? global?.baseUrl ?? env.LLM_BASE_URL ?? "";
    sources.baseUrl = tenant?.baseUrl ? "TENANT" : global?.baseUrl ? "GLOBAL" : "ENV";
    sources.keyRef = tenant?.keyRef ? "TENANT" : global?.keyRef ? "GLOBAL" : "ENV";
    sources.dailyTokenBudget =
      tenant?.dailyTokenBudget != null
        ? "TENANT"
        : global?.dailyTokenBudget != null
          ? "GLOBAL"
          : "GLOBAL";
    sources.monthlyTokenBudget =
      tenant?.monthlyTokenBudget != null
        ? "TENANT"
        : global?.monthlyTokenBudget != null
          ? "GLOBAL"
          : "GLOBAL";
    sources.modelAllowlist = tenant?.modelAllowlist
      ? "TENANT"
      : global?.modelAllowlist
        ? "GLOBAL"
        : "ENV";

    const allowlistFromRow = tenant?.modelAllowlist ?? global?.modelAllowlist ?? null;
    const modelAllowlist =
      allowlistFromRow === null
        ? parseModelAllowlist(env.LLM_MODEL_ALLOWLIST)
        : asStringArray(allowlistFromRow);

    const resolved = ResolvedLlmSettings.parse({
      provider: pick("provider", "openai-compatible"),
      baseUrl,
      defaultModel: pick("defaultModel", env.LLM_DEFAULT_MODEL ?? "", true),
      reasoningModel: pick("reasoningModel", env.LLM_REASONING_MODEL ?? "", true),
      modelAllowlist,
      dailyTokenBudget: tenant?.dailyTokenBudget ?? global?.dailyTokenBudget ?? null,
      monthlyTokenBudget: tenant?.monthlyTokenBudget ?? global?.monthlyTokenBudget ?? null,
      params: asRecord(tenant?.params ?? global?.params ?? {}),
      keyRef: tenant?.keyRef ?? global?.keyRef ?? "LLM_API_KEY",
      allowExternal: pick("allowExternal", true),
      logPrompts: pick("logPrompts", false),
      version: tenant?.version ?? global?.version ?? 1,
      sources,
    });
    return resolved;
  }

  /** 租户覆盖：只写自己的 TENANT 行；配置变更必须由人类发起并写审计。 */
  async upsertTenant(input: unknown, ctx: KernelContext): Promise<LlmSettings> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError("PERMISSION_DENIED", "LLM 设置变更必须由人类发起");
    }
    const parsed = UpdateLlmSettingsInput.parse(input);
    const env = loadEnv();
    const current = await this.db
      .select()
      .from(llmSettings)
      .where(and(eq(llmSettings.scope, "TENANT"), eq(llmSettings.tenantId, this.tenantId)))
      .limit(1);
    const before = current[0] ? mapRow(current[0]) : null;
    const now = new Date();

    const values = {
      tenantId: this.tenantId,
      provider: parsed.provider ?? before?.provider ?? "openai-compatible",
      baseUrl: parsed.baseUrl === undefined ? (before?.baseUrl ?? null) : parsed.baseUrl,
      defaultModel: parsed.defaultModel ?? before?.defaultModel ?? env.LLM_DEFAULT_MODEL ?? "",
      reasoningModel:
        parsed.reasoningModel ?? before?.reasoningModel ?? env.LLM_REASONING_MODEL ?? "",
      modelAllowlist:
        parsed.modelAllowlist ?? before?.modelAllowlist ?? parseModelAllowlist(env.LLM_MODEL_ALLOWLIST),
      dailyTokenBudget:
        parsed.dailyTokenBudget === undefined
          ? (before?.dailyTokenBudget ?? null)
          : parsed.dailyTokenBudget,
      monthlyTokenBudget:
        parsed.monthlyTokenBudget === undefined
          ? (before?.monthlyTokenBudget ?? null)
          : parsed.monthlyTokenBudget,
      params: parsed.params ?? before?.params ?? {},
      keyRef: parsed.keyRef === undefined ? (before?.keyRef ?? null) : parsed.keyRef,
      allowExternal: parsed.allowExternal ?? before?.allowExternal ?? true,
      logPrompts: parsed.logPrompts ?? before?.logPrompts ?? false,
      version: (before?.version ?? 0) + 1,
      updatedBy: ctx.actor.id,
      updatedAt: now,
    };

    if (!values.modelAllowlist.includes(values.defaultModel)) {
      throw new KernelError("KERNEL_REJECTED", "默认模型不在模型白名单内", {
        reason: "MODEL_NOT_ALLOWED",
      });
    }
    if (!values.modelAllowlist.includes(values.reasoningModel)) {
      throw new KernelError("KERNEL_REJECTED", "复杂任务模型不在模型白名单内", {
        reason: "MODEL_NOT_ALLOWED",
      });
    }

    return this.db.transaction(async (tx) => {
      const rows = before
        ? await tx.update(llmSettings).set(values).where(eq(llmSettings.id, before.id)).returning()
        : await tx
            .insert(llmSettings)
            .values({ ...values, scope: "TENANT" })
            .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("KERNEL_REJECTED", "LLM 配置写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "LLM_SETTINGS_UPDATED",
          entityType: "llm_settings",
          entityId: row.id,
          before: before
            ? {
                defaultModel: before.defaultModel,
                reasoningModel: before.reasoningModel,
                allowExternal: before.allowExternal,
                logPrompts: before.logPrompts,
                version: before.version,
              }
            : null,
          after: {
            defaultModel: row.defaultModel,
            reasoningModel: row.reasoningModel,
            allowExternal: row.allowExternal,
            logPrompts: row.logPrompts,
            version: row.version,
          },
        },
        this.tenantId,
      );
      return mapRow(row);
    });
  }
}
