ALTER TABLE "llm_settings" ALTER COLUMN "provider" SET DEFAULT 'openai-compatible';--> statement-breakpoint
ALTER TABLE "llm_settings" ALTER COLUMN "default_model" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "llm_settings" ALTER COLUMN "reasoning_model" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "llm_settings" ALTER COLUMN "key_ref" SET DEFAULT 'LLM_API_KEY';--> statement-breakpoint
-- 数据迁移：只改 provider / 旧 LiteLLM 容器地址 / Key 引用，
-- 不覆盖用户已经保存的模型、白名单、预算、allowExternal，也不重写历史 token_usage。
UPDATE "llm_settings" SET "provider" = 'openai-compatible' WHERE "provider" = 'litellm';--> statement-breakpoint
UPDATE "llm_settings" SET "base_url" = NULL
WHERE "base_url" IS NOT NULL
  AND (
    lower("base_url") LIKE '%litellm%'
    OR "base_url" LIKE 'http://localhost:4000%'
    OR "base_url" LIKE 'http://127.0.0.1:4000%'
  );--> statement-breakpoint
UPDATE "llm_settings" SET "key_ref" = 'LLM_API_KEY' WHERE "key_ref" = 'LITELLM_MASTER_KEY';--> statement-breakpoint
UPDATE "llm_settings" SET "key_ref" = regexp_replace("key_ref", '^LITELLM_TENANT_KEY_', 'LLM_TENANT_KEY_')
WHERE "key_ref" LIKE 'LITELLM_TENANT_KEY\_%' ESCAPE '\';