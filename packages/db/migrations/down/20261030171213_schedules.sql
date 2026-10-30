-- Dev-only reverse of 20261030171213_schedules (refused in production; see migrate-guard.ts). Drops both tables.
DROP TABLE "blackout_windows";--> statement-breakpoint
DROP TABLE "schedules";--> statement-breakpoint
ALTER TABLE "standing_authorisations" DROP CONSTRAINT "standing_authorisations_tenant_id_id_key";
