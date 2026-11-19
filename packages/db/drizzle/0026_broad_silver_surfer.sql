CREATE TABLE "customer_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" varchar(64),
	"phone" varchar(64),
	"phone_normalized" varchar(64),
	"email" varchar(255),
	"wechat" varchar(128),
	"note" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quote_shares" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_shares" ADD COLUMN "contact_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contacts_primary_idx" ON "customer_contacts" USING btree ("customer_id") WHERE "customer_contacts"."is_primary" AND "customer_contacts"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contacts_phone_idx" ON "customer_contacts" USING btree ("customer_id","phone_normalized") WHERE "customer_contacts"."phone_normalized" IS NOT NULL AND "customer_contacts"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contacts_email_idx" ON "customer_contacts" USING btree ("customer_id",lower("email")) WHERE "customer_contacts"."email" IS NOT NULL AND "customer_contacts"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "customer_contacts_tenant_customer_idx" ON "customer_contacts" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_contacts_tenant_active_idx" ON "customer_contacts" USING btree ("tenant_id","customer_id","is_primary") WHERE "customer_contacts"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "quote_shares" ADD CONSTRAINT "quote_shares_contact_id_customer_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_shares_tenant_contact_idx" ON "quote_shares" USING btree ("tenant_id","contact_id");--> statement-breakpoint

-- 回填（WAN-177 验收）：存量 customers.contact_* 三列回填为第一条主联系人。
-- drizzle-kit 重新生成迁移时不会保留手写数据语句，这段必须跟着迁移走：
-- 读路径已切到 customer_contacts，缺回填等于老客户的联系人凭空消失。
-- 幂等：not exists 保证重跑不会给同一客户建第二个主联系人；
-- name 为空落「主要联系人」；phone_normalized 保留前导 +，与 normalizePhone 口径一致。
INSERT INTO "customer_contacts"
  ("tenant_id", "customer_id", "name", "phone", "phone_normalized", "email", "is_primary")
SELECT
  c."tenant_id",
  c."id",
  COALESCE(NULLIF(BTRIM(c."contact_name"), ''), '主要联系人'),
  NULLIF(BTRIM(c."contact_phone"), ''),
  NULLIF(
    CASE
      WHEN LEFT(BTRIM(c."contact_phone"), 1) = '+'
        THEN '+' || REGEXP_REPLACE(BTRIM(c."contact_phone"), '[^0-9]', '', 'g')
      ELSE REGEXP_REPLACE(BTRIM(c."contact_phone"), '[^0-9]', '', 'g')
    END,
    ''
  ),
  NULLIF(BTRIM(c."contact_email"), ''),
  TRUE
FROM "customers" c
WHERE (
    NULLIF(BTRIM(c."contact_name"), '') IS NOT NULL
    OR NULLIF(BTRIM(c."contact_phone"), '') IS NOT NULL
    OR NULLIF(BTRIM(c."contact_email"), '') IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM "customer_contacts" cc WHERE cc."customer_id" = c."id"
  );
