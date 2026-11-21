ALTER TABLE "print_jobs" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "print_template_versions" ADD COLUMN "layout" jsonb;