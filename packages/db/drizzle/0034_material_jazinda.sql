ALTER TABLE "samples" ADD COLUMN "color" varchar(64);--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "weight_gsm" integer;--> statement-breakpoint
CREATE INDEX "samples_tenant_color_idx" ON "samples" USING btree ("tenant_id","color");--> statement-breakpoint
CREATE INDEX "samples_tenant_weight_gsm_idx" ON "samples" USING btree ("tenant_id","weight_gsm");--> statement-breakpoint
-- WAN-188 · 颜色并入字段选项：为存量租户补一份常用颜色推荐项。
-- 与 0025 同一形状，幂等可重复执行；新建租户由 createTenant 的 DEFAULT_FIELD_OPTIONS 种入。
INSERT INTO "field_options" ("tenant_id", "field_key", "code", "label", "normalized", "sort_order")
SELECT t."id", v."field_key", v."code", v."label", v."normalized", v."sort_order"
FROM "tenants" t
CROSS JOIN (VALUES
  ('sample.color', 'COLOR-BLACK', '黑色', '黑色', 10),
  ('sample.color', 'COLOR-WHITE', '白色', '白色', 20),
  ('sample.color', 'COLOR-NAVY',  '藏青', '藏青', 30),
  ('sample.color', 'COLOR-GREY',  '灰色', '灰色', 40),
  ('sample.color', 'COLOR-BEIGE', '米白', '米白', 50),
  ('sample.color', 'COLOR-KHAKI', '卡其', '卡其', 60),
  ('sample.color', 'COLOR-BLUE',  '蓝色', '蓝色', 70),
  ('sample.color', 'COLOR-RED',   '红色', '红色', 80)
) AS v("field_key", "code", "label", "normalized", "sort_order")
-- 不带冲突目标：label 被改过的租户重跑时会撞 code 唯一约束，无目标 DO NOTHING 更稳。
ON CONFLICT DO NOTHING;
