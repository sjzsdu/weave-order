ALTER TABLE "samples" ADD COLUMN "weight_value" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "weight_unit" varchar(8);--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "width_value" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "width_unit" varchar(8);--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "width_cm" integer;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "weight_text" varchar(64);