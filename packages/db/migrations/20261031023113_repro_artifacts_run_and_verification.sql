DROP INDEX "repro_artifacts_finding_id_idx";--> statement-breakpoint
ALTER TABLE "repro_artifacts" ADD COLUMN "run_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "repro_artifacts" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "repro_artifacts_tenant_finding_idx" ON "repro_artifacts" USING btree ("tenant_id","finding_id");--> statement-breakpoint
CREATE INDEX "repro_artifacts_run_id_idx" ON "repro_artifacts" USING btree ("run_id");--> statement-breakpoint
-- Hand-written below (Drizzle models neither grants nor column privileges). Reviewed.
-- Write-once (CONTEXT_PACK §8.8) still holds for the bundle bytes: the runtime role may set verified_at, once, and nothing
-- else. The column grant re-opens UPDATE on those two columns only, so changing sha256 or bundle_key is refused by the database.
GRANT UPDATE ("verified_at", "updated_at") ON "repro_artifacts" TO bw_app;
