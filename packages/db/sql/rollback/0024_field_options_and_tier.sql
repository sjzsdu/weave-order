-- WAN-176 · 0024 的反迁移（人工执行，不参与 drizzle 自动迁移）
--
-- 前提：`customers.tier` 的值仍全部落在旧枚举值域内（VIP / REGULAR / NEW / COLD）。
-- 自定义等级（T- 前缀）一旦被写入，本脚本会在 `tier::customer_tier` 处报错并整体回滚——
-- 这是有意的 fail-closed：不允许把无法映射的数据静默丢弃。
--
-- 用法：psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/sql/rollback/0024_field_options_and_tier.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'customer_tier') THEN
    CREATE TYPE "public"."customer_tier" AS ENUM ('VIP', 'REGULAR', 'NEW', 'COLD');
  END IF;
END $$;

ALTER TABLE "customers" ALTER COLUMN "tier" DROP DEFAULT;
ALTER TABLE "customers" ALTER COLUMN "tier" SET DATA TYPE "public"."customer_tier"
  USING "tier"::text::"public"."customer_tier";
ALTER TABLE "customers" ALTER COLUMN "tier" SET DEFAULT 'REGULAR';

DROP INDEX IF EXISTS "customers_tenant_tier_idx";

ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "actor_name";
ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "entity_label";

DROP INDEX IF EXISTS "field_options_tenant_field_sort_idx";
DROP TABLE IF EXISTS "field_options";

COMMIT;
