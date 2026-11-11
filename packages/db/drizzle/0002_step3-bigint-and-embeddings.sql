CREATE TABLE "sample_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sample_id" uuid NOT NULL,
	"model" varchar(64) NOT NULL,
	"dimension" integer NOT NULL,
	"embedding" real[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "samples" ALTER COLUMN "cost_floor_amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "quantity_milli" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "unit_price_amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "line_total_amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "quotes" ALTER COLUMN "subtotal_amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "quotes" ALTER COLUMN "total_amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "sample_shipment_items" ALTER COLUMN "quantity_milli" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "sample_embeddings" ADD CONSTRAINT "sample_embeddings_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sample_embeddings_sample_model_idx" ON "sample_embeddings" USING btree ("sample_id","model");--> statement-breakpoint
CREATE INDEX "sample_embeddings_model_idx" ON "sample_embeddings" USING btree ("model");