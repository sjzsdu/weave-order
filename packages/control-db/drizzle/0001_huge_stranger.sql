CREATE TYPE "control"."refund_status" AS ENUM('REQUESTED', 'APPROVED', 'REJECTED');--> statement-breakpoint
ALTER TYPE "control"."approval_action" ADD VALUE 'REFUND' BEFORE 'BREAK_GLASS';--> statement-breakpoint
CREATE TABLE "control"."refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"reason" varchar(500) NOT NULL,
	"status" "control"."refund_status" DEFAULT 'REQUESTED' NOT NULL,
	"requested_by" varchar(128) NOT NULL,
	"approved_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control"."refunds" ADD CONSTRAINT "refunds_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "control"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_refunds_invoice_idx" ON "control"."refunds" USING btree ("invoice_id");