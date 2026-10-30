-- Dev-only reverse of 20261030225104_coverage_entries_and_manifest_lifecycle (refused in production; see migrate-guard.ts). Drops the per-case coverage rows and the manifest lifecycle columns, constraints and keys added with them.
DROP TABLE "coverage_entries";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP CONSTRAINT "coverage_manifests_summary_check";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP CONSTRAINT "coverage_manifests_pins_check";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP CONSTRAINT "coverage_manifests_sha256_check";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP CONSTRAINT "coverage_manifests_finalised_fields_check";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP CONSTRAINT "coverage_manifests_status_finalised_at_check";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP CONSTRAINT "coverage_manifests_status_check";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP CONSTRAINT "coverage_manifests_public_id_check";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP CONSTRAINT "coverage_manifests_public_id_key";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP CONSTRAINT "coverage_manifests_tenant_id_id_unique";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP COLUMN "finalised_by";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP COLUMN "summary";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP COLUMN "sha256";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP COLUMN "pins";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "coverage_manifests" DROP COLUMN "public_id";
