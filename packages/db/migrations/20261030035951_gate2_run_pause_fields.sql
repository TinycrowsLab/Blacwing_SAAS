ALTER TABLE "runs" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "resume_to" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_pause_reason_check" CHECK ("runs"."pause_reason" IS NULL OR "runs"."pause_reason" IN ('gate2_pending', 'cost_cap', 'operator_pause', 'window_closed'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_pause_fields_check" CHECK (("runs"."state" = 'paused') = ("runs"."pause_reason" IS NOT NULL AND "runs"."resume_to" IS NOT NULL));