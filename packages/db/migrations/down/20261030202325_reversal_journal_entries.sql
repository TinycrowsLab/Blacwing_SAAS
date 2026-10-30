-- Dev-only reverse of 20261030202325_reversal_journal_entries (refused in production; see migrate-guard.ts). Drops the
-- journal table and the test_cases key it referenced.
DROP TABLE "reversal_journal_entries";--> statement-breakpoint
ALTER TABLE "test_cases" DROP CONSTRAINT "test_cases_tenant_id_id_unique";
