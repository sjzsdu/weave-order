ALTER TABLE "inbound_messages" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "raw_payload_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "classification" jsonb;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "quote_draft_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_messages_tenant_shipment_idx" ON "inbound_messages" USING btree ("tenant_id","shipment_id");--> statement-breakpoint
CREATE INDEX "inbound_messages_raw_expires_idx" ON "inbound_messages" USING btree ("raw_payload_expires_at");--> statement-breakpoint
CREATE INDEX "inbound_messages_tenant_customer_received_idx" ON "inbound_messages" USING btree ("tenant_id","customer_id","received_at");--> statement-breakpoint
UPDATE "llm_settings"
   SET "model_allowlist" = ("model_allowlist"::jsonb || '["qwen-vl-plus"]'::jsonb)
 WHERE jsonb_typeof("model_allowlist"::jsonb) = 'array'
   AND NOT ("model_allowlist"::jsonb @> '["qwen-vl-plus"]'::jsonb);