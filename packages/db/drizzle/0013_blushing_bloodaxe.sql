CREATE TABLE "receivable_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receivable_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" "currency" NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"note" varchar(255),
	"proof_object_key" varchar(512),
	"recorded_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receivable_payments_amount_positive" CHECK ("receivable_payments"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_receivable_id_receivables_id_fk" FOREIGN KEY ("receivable_id") REFERENCES "public"."receivables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receivable_payments_tenant_receivable_idx" ON "receivable_payments" USING btree ("tenant_id","receivable_id","paid_at");--> statement-breakpoint
CREATE INDEX "receivable_payments_tenant_paid_at_idx" ON "receivable_payments" USING btree ("tenant_id","paid_at");--> statement-breakpoint
-- 租户隔离：回款流水与所有业务表同一策略，rls.sql 每次迁移后幂等重放。
ALTER TABLE "receivable_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "receivable_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "receivable_payments";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "receivable_payments"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
