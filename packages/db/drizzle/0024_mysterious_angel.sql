-- WAN-176 · P0 地基
--
-- 1) 字段选项表（客户等级 / 样品品类 / 样品成分 / 联系人角色共表）
-- 2) customers.tier：Postgres enum → varchar(64)（存 field_options.code）
-- 3) audit_log 展示快照两列
--
-- 顺序有依赖：先建表并种子，再改列类型，最后删旧枚举。
-- 回滚脚本：packages/db/sql/rollback/0024_field_options_and_tier.sql

CREATE TABLE IF NOT EXISTS "field_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"field_key" varchar(64) NOT NULL,
	"code" varchar(64) NOT NULL,
	"label" varchar(128) NOT NULL,
	"normalized" varchar(128) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_options_tenant_field_normalized_uq" UNIQUE("tenant_id","field_key","normalized"),
	CONSTRAINT "field_options_tenant_field_code_uq" UNIQUE("tenant_id","field_key","code")
);
--> statement-breakpoint

-- 每个现存租户各写入一份等级预置项。code 沿用旧枚举值，存量客户零改动即可继续解析；
-- 幂等：重复执行命中唯一约束直接跳过。
INSERT INTO "field_options" ("tenant_id", "field_key", "code", "label", "normalized", "sort_order")
SELECT t."id", 'customer.tier', v."code", v."label", v."normalized", v."sort_order"
FROM "tenants" t
CROSS JOIN (VALUES
  ('NEW',     '新客', '新客', 10),
  ('REGULAR', '常规', '常规', 20),
  ('VIP',     'VIP',  'vip',  30),
  ('COLD',    '沉睡', '沉睡', 40)
) AS v("code", "label", "normalized", "sort_order")
ON CONFLICT ("tenant_id", "field_key", "normalized") DO NOTHING;
--> statement-breakpoint

-- label 改名与 code 解耦：normalized 取 label 的归一化值；code 仍按旧枚举字面量保留。
-- 若某租户先于本迁移手动建过同 code 的行，唯一约束会在这里报错——宁可失败也不静默覆盖。

ALTER TABLE "customers" ALTER COLUMN "tier" DROP DEFAULT;--> statement-breakpoint
-- enum → varchar 必须显式 USING，否则 Postgres 拒绝隐式转换；tier::text 与旧枚举值逐字一致，无损。
ALTER TABLE "customers" ALTER COLUMN "tier" SET DATA TYPE varchar(64) USING "tier"::text;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "tier" SET DEFAULT 'REGULAR';--> statement-breakpoint

ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "actor_name" varchar(128);--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "entity_label" varchar(255);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "field_options_tenant_field_sort_idx"
  ON "field_options" USING btree ("tenant_id","field_key","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_tenant_tier_idx"
  ON "customers" USING btree ("tenant_id","tier");--> statement-breakpoint

-- 列已不再引用旧类型，枚举退场。回滚脚本会按原值域重建。
DROP TYPE IF EXISTS "public"."customer_tier";
