CREATE TABLE "coverage_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"finalised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coverage_manifests_tenant_id_run_id_key" UNIQUE("tenant_id","run_id"),
	CONSTRAINT "coverage_manifests_entries_check" CHECK (jsonb_typeof("coverage_manifests"."entries") = 'array' AND octet_length("coverage_manifests"."entries"::text) <= 1048576)
);
--> statement-breakpoint
ALTER TABLE "coverage_manifests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "public_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "manifest" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "impact" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "evidence_narrative" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "severity_rationale" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "remediation_summary" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "asvs_refs" jsonb;--> statement-breakpoint
-- NOT VALID: `runs` is already FORCE ROW LEVEL SECURITY, so validating this key against existing rows would run the
-- tenant policy as the owner with no tenant set. The table is created empty here, so there is nothing to validate;
-- every later insert and update is still checked by the key.
ALTER TABLE "coverage_manifests" ADD CONSTRAINT "coverage_manifests_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "coverage_manifests_tenant_id_idx" ON "coverage_manifests" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_public_id_key" ON "runs" USING btree ("public_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_public_id_check" CHECK ("runs"."public_id" IS NULL OR starts_with("runs"."public_id", 'run_'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_manifest_check" CHECK ("runs"."manifest" IS NULL OR jsonb_typeof("runs"."manifest") = 'object');--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_narrative_check" CHECK (("findings"."description" IS NULL OR length("findings"."description") BETWEEN 1 AND 2000)
        AND ("findings"."impact" IS NULL OR length("findings"."impact") BETWEEN 1 AND 2000)
        AND ("findings"."evidence_narrative" IS NULL OR length("findings"."evidence_narrative") BETWEEN 1 AND 2000)
        AND ("findings"."severity_rationale" IS NULL OR length("findings"."severity_rationale") BETWEEN 1 AND 2000)
        AND ("findings"."remediation_summary" IS NULL OR length("findings"."remediation_summary") BETWEEN 1 AND 2000));--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_asvs_refs_check" CHECK ("findings"."asvs_refs" IS NULL OR (jsonb_typeof("findings"."asvs_refs") = 'array' AND jsonb_array_length("findings"."asvs_refs") <= 32 AND octet_length("findings"."asvs_refs"::text) <= 4096));--> statement-breakpoint
CREATE POLICY "coverage_manifests_tenant_isolation" ON "coverage_manifests" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY, grants nor triggers). Reviewed.
-- FORCE: the owner role is subject to the tenant policy too, so nothing reads across tenants.
ALTER TABLE "coverage_manifests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "coverage_manifests" FROM PUBLIC;--> statement-breakpoint
-- The runtime role reads, creates and finalises a manifest; it never deletes one (F19: the report needs it).
REVOKE DELETE, TRUNCATE ON "coverage_manifests" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "coverage_manifests" TO bw_app;--> statement-breakpoint
-- Immutable once finalised: after `finalised_at` is set, no update and no delete reaches the row, whatever the role.
CREATE OR REPLACE FUNCTION bw_coverage_manifest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finalised_at IS NOT NULL THEN
    RAISE EXCEPTION 'coverage manifest % is finalised and immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER coverage_manifests_guard BEFORE UPDATE OR DELETE ON "coverage_manifests" FOR EACH ROW EXECUTE FUNCTION bw_coverage_manifest_guard();--> statement-breakpoint
CREATE TRIGGER coverage_manifests_set_updated_at BEFORE UPDATE ON "coverage_manifests" FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at();
