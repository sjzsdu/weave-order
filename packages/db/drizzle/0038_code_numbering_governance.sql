-- 五类实体编号体系治理（设计文档 docs/code-numbering-customization.md v0.2）
--
-- M1 阻断式前置检查：订单存量按 (tenant_id, code) 分组，同租户重号则直接失败，
-- 不给「改用非唯一索引」这种违背验收标准的降级路径。人工清理后重跑本迁移。
-- 注意：本迁移由 owner 角色（superuser / BYPASSRLS）执行，能读到全部租户行。
DO $$
DECLARE dup record;
BEGIN
  SELECT tenant_id, code, count(*) AS n INTO dup
  FROM orders
  GROUP BY tenant_id, code
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      '订单存在同租户重号，迁移阻断：tenant_id=% code=% 共 % 条。请先人工清理（保留一笔、其余显式改码）后重跑',
      dup.tenant_id, dup.code, dup.n;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "code_counters" (
	"tenant_id" uuid NOT NULL,
	"entity_type" varchar(32) NOT NULL,
	"bucket" varchar(128) NOT NULL,
	"seq" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_counters_tenant_id_entity_type_bucket_pk" PRIMARY KEY("tenant_id","entity_type","bucket")
);
--> statement-breakpoint
CREATE TABLE "code_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" varchar(32) NOT NULL,
	"template" varchar(128) NOT NULL,
	"preset_key" varchar(64),
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "code" varchar(64);--> statement-breakpoint
ALTER TABLE "sample_shipments" ADD COLUMN "code" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "code_rules_tenant_entity_idx" ON "code_rules" USING btree ("tenant_id","entity_type");--> statement-breakpoint
CREATE INDEX "code_rules_tenant_idx" ON "code_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_tenant_code_idx" ON "quotes" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "sample_shipments_tenant_code_idx" ON "sample_shipments" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_code_idx" ON "orders" USING btree ("tenant_id","code");
--> statement-breakpoint
-- RLS：与所有业务表一致，tenant_id = 会话租户；rls.sql 每次 migrate 后幂等重放同一份定义。
ALTER TABLE "code_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "code_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "code_rules";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "code_rules"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "code_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "code_counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "code_counters";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "code_counters"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- M6 计数器回填：按 classic 前缀从存量最大号初始化，避免启用规则后首单撞历史号。
-- classic 编号形如 C261116-0001：前缀 8 字符（C + 6 位日期 + '-'），序号从第 9 字符起。
-- 只回填符合 classic 格式的历史编号；自定义格式无存量，不参与。
INSERT INTO code_counters (tenant_id, entity_type, bucket, seq, updated_at)
SELECT tenant_id, 'customer', substring(code from 1 for 8), max(substring(code from 9)::int), now()
FROM customers
WHERE code ~ '^C[0-9]{6}-[0-9]+$'
GROUP BY tenant_id, substring(code from 1 for 8)
ON CONFLICT (tenant_id, entity_type, bucket) DO UPDATE
  SET seq = GREATEST(code_counters.seq, excluded.seq), updated_at = now();--> statement-breakpoint
INSERT INTO code_counters (tenant_id, entity_type, bucket, seq, updated_at)
SELECT tenant_id, 'sample', substring(code from 1 for 8), max(substring(code from 9)::int), now()
FROM samples
WHERE code ~ '^S[0-9]{6}-[0-9]+$'
GROUP BY tenant_id, substring(code from 1 for 8)
ON CONFLICT (tenant_id, entity_type, bucket) DO UPDATE
  SET seq = GREATEST(code_counters.seq, excluded.seq), updated_at = now();
