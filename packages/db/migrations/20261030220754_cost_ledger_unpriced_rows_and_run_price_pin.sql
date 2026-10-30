ALTER TABLE "cost_ledger" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ALTER COLUMN "price_table_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "price_table_version" bigint;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "needs_pricing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_price_table_version_check" CHECK ("runs"."price_table_version" IS NULL OR "runs"."price_table_version" >= 1);--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_pricing_check" CHECK ("cost_ledger"."needs_pricing" = ("cost_ledger"."price_table_id" IS NULL) AND (NOT "cost_ledger"."needs_pricing" OR "cost_ledger"."cost_usd" = 0));