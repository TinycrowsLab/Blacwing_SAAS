CREATE TABLE "repro_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"bundle_key" text NOT NULL,
	"sha256" text NOT NULL,
	"format_version" text NOT NULL,
	"size" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repro_artifacts_public_id_check" CHECK ("repro_artifacts"."public_id" ~ '^rpa_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
	CONSTRAINT "repro_artifacts_bundle_key_check" CHECK (length("repro_artifacts"."bundle_key") BETWEEN 1 AND 512 AND starts_with("repro_artifacts"."bundle_key", "repro_artifacts"."tenant_id"::text || '/')),
	CONSTRAINT "repro_artifacts_sha256_check" CHECK ("repro_artifacts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "repro_artifacts_format_version_check" CHECK (length("repro_artifacts"."format_version") BETWEEN 1 AND 32),
	CONSTRAINT "repro_artifacts_size_check" CHECK ("repro_artifacts"."size" IS NULL OR ("repro_artifacts"."size" >= 0 AND "repro_artifacts"."size" <= 5368709120))
);
--> statement-breakpoint
ALTER TABLE "repro_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD COLUMN "public_id" text;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD COLUMN "finding_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD COLUMN "occurrence_id" uuid;--> statement-breakpoint
-- The target of evidence_items_occurrence_fk: it must exist before that foreign key is added.
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
-- NOT VALID: every new column is NULL on existing rows and the new table is empty, so there is nothing to validate.
-- The check still runs on every insert or update. Validating now would evaluate the findings policy, whose current_setting() fails when no tenant is set.
ALTER TABLE "repro_artifacts" ADD CONSTRAINT "repro_artifacts_finding_fk" FOREIGN KEY ("tenant_id","finding_id") REFERENCES "public"."findings"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "repro_artifacts_tenant_id_idx" ON "repro_artifacts" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repro_artifacts_public_id_key" ON "repro_artifacts" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repro_artifacts_bundle_key_key" ON "repro_artifacts" USING btree ("bundle_key");--> statement-breakpoint
CREATE INDEX "repro_artifacts_finding_id_idx" ON "repro_artifacts" USING btree ("finding_id");--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_finding_fk" FOREIGN KEY ("tenant_id","finding_id") REFERENCES "public"."findings"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_occurrence_fk" FOREIGN KEY ("tenant_id","occurrence_id") REFERENCES "public"."finding_occurrences"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_items_public_id_key" ON "evidence_items" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "evidence_items_finding_id_sequence_idx" ON "evidence_items" USING btree ("finding_id","sequence");--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_public_id_check" CHECK ("evidence_items"."public_id" IS NULL OR "evidence_items"."public_id" ~ '^evd_[0-9abcdefghjkmnpqrstvwxyz]{26}$');--> statement-breakpoint
CREATE POLICY "repro_artifacts_tenant_isolation" ON "repro_artifacts" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY nor grants). Reviewed.
-- FORCE: the owner role is subject to the tenant policy too, so nothing reads across tenants.
ALTER TABLE "repro_artifacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Write-once (CONTEXT_PACK §8.8): the runtime role may create and read a bundle, never change or remove it.
REVOKE ALL ON "repro_artifacts" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "repro_artifacts" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "repro_artifacts" TO bw_app;
--> statement-breakpoint
-- Append-only with one exception (CONTEXT_PACK §8.8): retention and legal hold are the only mutable fields of an
-- evidence item (updated_at records the change). The column grant re-opens UPDATE on those columns only, so changing
-- object_key or sha256 is refused by the database (42501), not only by the repository.
GRANT UPDATE ("retention_until", "legal_hold", "updated_at") ON "evidence_items" TO bw_app;
