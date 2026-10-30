-- Dev-only reverse of 20261030181728_finding_triage_duplicate_of (refused in production; see migrate-guard.ts). Drops the duplicate_of column with its check, foreign key and index.
ALTER TABLE "findings" DROP CONSTRAINT "findings_duplicate_of_check";--> statement-breakpoint
ALTER TABLE "findings" DROP CONSTRAINT "findings_duplicate_of_fk";--> statement-breakpoint
DROP INDEX "findings_tenant_id_duplicate_of_idx";--> statement-breakpoint
ALTER TABLE "findings" DROP COLUMN "duplicate_of";
