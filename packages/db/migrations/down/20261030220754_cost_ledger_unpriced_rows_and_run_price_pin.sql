-- Dev-only reverse of 20261030220754_cost_ledger_unpriced_rows_and_run_price_pin (refused in production; see migrate-guard.ts). Drops the pricing check, needs_pricing and the run price pin, then restores NOT NULL on run_id and price_table_id (fails if unpriced or unattributed rows exist).
ALTER TABLE "cost_ledger" DROP CONSTRAINT "cost_ledger_pricing_check";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_price_table_version_check";--> statement-breakpoint
ALTER TABLE "cost_ledger" DROP COLUMN "needs_pricing";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "price_table_version";--> statement-breakpoint
ALTER TABLE "cost_ledger" ALTER COLUMN "price_table_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ALTER COLUMN "run_id" SET NOT NULL;
