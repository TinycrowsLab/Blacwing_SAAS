CREATE TABLE "coverage_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"test_case_id" uuid NOT NULL,
	"title" text NOT NULL,
	"class" text NOT NULL,
	"owasp_refs" text[] DEFAULT '{}' NOT NULL,
	"wstg_refs" text[] DEFAULT '{}' NOT NULL,
	"cwe_candidates" text[] DEFAULT '{}' NOT NULL,
	"targets" jsonb NOT NULL,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"subtask_id" uuid,
	"budget_used" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coverage_entries_manifest_id_test_case_id_key" UNIQUE("manifest_id","test_case_id"),
	CONSTRAINT "coverage_entries_title_check" CHECK (length("coverage_entries"."title") >= 1),
	CONSTRAINT "coverage_entries_class_check" CHECK ("coverage_entries"."class" IN ('passive', 'active_safe', 'state_changing', 'destructive')),
	CONSTRAINT "coverage_entries_outcome_check" CHECK ("coverage_entries"."outcome" IN ('executed', 'skipped', 'blocked', 'model_declined', 'out_of_budget', 'gate_denied', 'not_applicable', 'failed')),
	CONSTRAINT "coverage_entries_reason_check" CHECK (("coverage_entries"."outcome" = 'executed') = ("coverage_entries"."reason" IS NULL) AND ("coverage_entries"."reason" IS NULL OR length("coverage_entries"."reason") BETWEEN 1 AND 2000)),
	CONSTRAINT "coverage_entries_targets_array_check" CHECK (jsonb_typeof("coverage_entries"."targets") = 'array' AND jsonb_array_length("coverage_entries"."targets") >= 1 AND octet_length("coverage_entries"."targets"::text) <= 16384),
	CONSTRAINT "coverage_entries_budget_used_check" CHECK ("coverage_entries"."budget_used" IS NULL OR (jsonb_typeof("coverage_entries"."budget_used") = 'object' AND octet_length("coverage_entries"."budget_used"::text) <= 16384))
);
--> statement-breakpoint
ALTER TABLE "coverage_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD COLUMN "public_id" text;--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD COLUMN "pins" jsonb;--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD COLUMN "finalised_by" uuid;--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD CONSTRAINT "coverage_manifests_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
-- NOT VALID: the referenced table is FORCE row level security, so validating this key would run the tenant policy as
-- the owner with no tenant set (see the note on coverage_manifests_run_fk). The table is created empty here, so there is
-- nothing to validate; every later insert and update is still checked by the key.
ALTER TABLE "coverage_entries" ADD CONSTRAINT "coverage_entries_manifest_fk" FOREIGN KEY ("tenant_id","manifest_id") REFERENCES "public"."coverage_manifests"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "coverage_entries" ADD CONSTRAINT "coverage_entries_test_case_fk" FOREIGN KEY ("tenant_id","test_case_id") REFERENCES "public"."test_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "coverage_entries_tenant_id_idx" ON "coverage_entries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "coverage_entries_manifest_id_outcome_idx" ON "coverage_entries" USING btree ("manifest_id","outcome");--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD CONSTRAINT "coverage_manifests_public_id_key" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD CONSTRAINT "coverage_manifests_public_id_check" CHECK ("coverage_manifests"."public_id" IS NULL OR starts_with("coverage_manifests"."public_id", 'cov_'));--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD CONSTRAINT "coverage_manifests_status_check" CHECK ("coverage_manifests"."status" IN ('open', 'finalised'));--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD CONSTRAINT "coverage_manifests_status_finalised_at_check" CHECK (("coverage_manifests"."status" = 'finalised') = ("coverage_manifests"."finalised_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD CONSTRAINT "coverage_manifests_finalised_fields_check" CHECK (("coverage_manifests"."status" = 'finalised') = ("coverage_manifests"."sha256" IS NOT NULL AND "coverage_manifests"."pins" IS NOT NULL AND "coverage_manifests"."summary" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD CONSTRAINT "coverage_manifests_sha256_check" CHECK ("coverage_manifests"."sha256" IS NULL OR "coverage_manifests"."sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD CONSTRAINT "coverage_manifests_pins_check" CHECK ("coverage_manifests"."pins" IS NULL OR (jsonb_typeof("coverage_manifests"."pins") = 'object' AND octet_length("coverage_manifests"."pins"::text) <= 16384));--> statement-breakpoint
ALTER TABLE "coverage_manifests" ADD CONSTRAINT "coverage_manifests_summary_check" CHECK ("coverage_manifests"."summary" IS NULL OR (jsonb_typeof("coverage_manifests"."summary") = 'object' AND octet_length("coverage_manifests"."summary"::text) <= 16384));--> statement-breakpoint
CREATE POLICY "coverage_entries_tenant_isolation" ON "coverage_entries" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY, grants nor triggers). Reviewed.
-- FORCE: the owner role is subject to the tenant policy too, so nothing reads across tenants.
ALTER TABLE "coverage_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "coverage_entries" FROM PUBLIC;--> statement-breakpoint
-- The runtime role records and updates per-case rows; it never deletes one (the manifest is the audit record).
REVOKE DELETE, TRUNCATE ON "coverage_entries" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "coverage_entries" TO bw_app;--> statement-breakpoint
CREATE TRIGGER coverage_entries_set_updated_at BEFORE UPDATE ON "coverage_entries" FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at();
