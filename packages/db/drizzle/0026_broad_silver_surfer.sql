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
CREATE INDEX "quote_shares_tenant_contact_idx" ON "quote_shares" USING btree ("tenant_id","contact_id");