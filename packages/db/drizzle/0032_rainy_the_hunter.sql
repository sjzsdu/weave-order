ALTER TABLE "quotes" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "confirm_idempotency_key" varchar(128);--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quotes_tenant_item_idx" ON "quotes" USING btree ("tenant_id","item_id");