CREATE TABLE "cve_records" (
	"cve_id" text PRIMARY KEY NOT NULL,
	"published" timestamp with time zone,
	"last_modified" timestamp with time zone,
	"cvss_v31" jsonb,
	"cvss_v40" jsonb,
	"cwe_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"cpe_matches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"source_updated" timestamp with time zone,
	CONSTRAINT "cve_records_cve_id_check" CHECK ("cve_records"."cve_id" ~ '^CVE-[0-9]{4}-[0-9]{4,}$'),
	CONSTRAINT "cve_records_cvss_v31_check" CHECK ("cve_records"."cvss_v31" IS NULL OR (jsonb_typeof("cve_records"."cvss_v31") = 'object' AND COALESCE(jsonb_typeof("cve_records"."cvss_v31"->'vector'), '') = 'string' AND COALESCE(jsonb_typeof("cve_records"."cvss_v31"->'baseScore'), '') = 'number')),
	CONSTRAINT "cve_records_cvss_v40_check" CHECK ("cve_records"."cvss_v40" IS NULL OR (jsonb_typeof("cve_records"."cvss_v40") = 'object' AND COALESCE(jsonb_typeof("cve_records"."cvss_v40"->'vector'), '') = 'string' AND COALESCE(jsonb_typeof("cve_records"."cvss_v40"->'baseScore'), '') = 'number')),
	CONSTRAINT "cve_records_cwe_ids_check" CHECK (cardinality("cve_records"."cwe_ids") <= 32),
	CONSTRAINT "cve_records_cpe_matches_check" CHECK (jsonb_typeof("cve_records"."cpe_matches") = 'array' AND octet_length("cve_records"."cpe_matches"::text) <= 65536),
	CONSTRAINT "cve_records_description_check" CHECK ("cve_records"."description" IS NULL OR length("cve_records"."description") <= 16384)
);
--> statement-breakpoint
CREATE TABLE "cwe_catalogue" (
	"cwe_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"abstraction" text NOT NULL,
	"relationships" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "cwe_catalogue_cwe_id_check" CHECK ("cwe_catalogue"."cwe_id" ~ '^CWE-[1-9][0-9]{0,4}$'),
	CONSTRAINT "cwe_catalogue_relationships_check" CHECK (octet_length("cwe_catalogue"."relationships"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "epss_scores" (
	"cve_id" text PRIMARY KEY NOT NULL,
	"epss" numeric NOT NULL,
	"percentile" numeric NOT NULL,
	"score_date" date NOT NULL,
	CONSTRAINT "epss_scores_cve_id_check" CHECK ("epss_scores"."cve_id" ~ '^CVE-[0-9]{4}-[0-9]{4,}$'),
	CONSTRAINT "epss_scores_range_check" CHECK ("epss_scores"."epss" BETWEEN 0 AND 1 AND "epss_scores"."percentile" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "finding_intel" (
	"tenant_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"cve_id" text NOT NULL,
	"kev" boolean DEFAULT false NOT NULL,
	"epss" numeric,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_intel_pk" PRIMARY KEY("tenant_id","finding_id","cve_id"),
	CONSTRAINT "finding_intel_cve_id_check" CHECK ("finding_intel"."cve_id" ~ '^CVE-[0-9]{4}-[0-9]{4,}$'),
	CONSTRAINT "finding_intel_epss_check" CHECK ("finding_intel"."epss" IS NULL OR "finding_intel"."epss" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "finding_intel" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kev_entries" (
	"cve_id" text PRIMARY KEY NOT NULL,
	"date_added" date NOT NULL,
	"due_date" date,
	"known_ransomware" boolean DEFAULT false NOT NULL,
	"notes" text,
	CONSTRAINT "kev_entries_cve_id_check" CHECK ("kev_entries"."cve_id" ~ '^CVE-[0-9]{4}-[0-9]{4,}$'),
	CONSTRAINT "kev_entries_notes_check" CHECK ("kev_entries"."notes" IS NULL OR length("kev_entries"."notes") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "osv_advisories" (
	"osv_id" text PRIMARY KEY NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"ghsa_id" text,
	"ecosystem" text NOT NULL,
	"package" text NOT NULL,
	"affected_ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"severity" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"modified" timestamp with time zone,
	CONSTRAINT "osv_advisories_ghsa_id_check" CHECK ("osv_advisories"."ghsa_id" IS NULL OR "osv_advisories"."ghsa_id" ~ '^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$'),
	CONSTRAINT "osv_advisories_json_check" CHECK (octet_length("osv_advisories"."affected_ranges"::text) <= 65536 AND octet_length("osv_advisories"."severity"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "owasp_mappings" (
	"scheme" text NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"cwe_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "owasp_mappings_pk" PRIMARY KEY("scheme","code"),
	CONSTRAINT "owasp_mappings_scheme_check" CHECK ("owasp_mappings"."scheme" IN ('top10_2021', 'api_top10_2023')),
	CONSTRAINT "owasp_mappings_code_check" CHECK (length("owasp_mappings"."code") BETWEEN 1 AND 16)
);
--> statement-breakpoint
CREATE TABLE "source_sync_state" (
	"source" text PRIMARY KEY NOT NULL,
	"last_run" timestamp with time zone,
	"last_cursor" text,
	"record_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	CONSTRAINT "source_sync_state_source_check" CHECK ("source_sync_state"."source" IN ('nvd', 'cisa_kev', 'first_epss', 'osv', 'ghsa', 'mitre_cwe', 'owasp')),
	CONSTRAINT "source_sync_state_status_check" CHECK ("source_sync_state"."status" IN ('idle', 'running', 'succeeded', 'failed')),
	CONSTRAINT "source_sync_state_record_count_check" CHECK ("source_sync_state"."record_count" >= 0),
	CONSTRAINT "source_sync_state_last_error_check" CHECK ("source_sync_state"."last_error" IS NULL OR length("source_sync_state"."last_error") <= 2000)
);
--> statement-breakpoint
-- NOT VALID (as verification_challenges, ASSET-001): "findings" is FORCE RLS (FINDING-001), so validating this foreign key
-- (a scan of "findings" as the owner) is refused with no tenant context. The table is created empty here, so there is nothing
-- to validate. Inserts are still checked: the referential-integrity trigger runs with RLS bypassed and requires the parent in
-- the same tenant (composite key). Do not run VALIDATE CONSTRAINT on it: that scan has the same problem.
ALTER TABLE "finding_intel" ADD CONSTRAINT "finding_intel_finding_fk" FOREIGN KEY ("tenant_id","finding_id") REFERENCES "public"."findings"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "cve_records_cpe_matches_gin_idx" ON "cve_records" USING gin ("cpe_matches" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "cve_records_cwe_ids_gin_idx" ON "cve_records" USING gin ("cwe_ids");--> statement-breakpoint
CREATE INDEX "epss_scores_score_date_idx" ON "epss_scores" USING btree ("score_date");--> statement-breakpoint
CREATE INDEX "finding_intel_tenant_id_idx" ON "finding_intel" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "osv_advisories_ecosystem_package_idx" ON "osv_advisories" USING btree ("ecosystem","package");--> statement-breakpoint
CREATE POLICY "finding_intel_tenant_isolation" ON "finding_intel" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY nor grants). Reviewed.
-- Reference data is global and shared read-only (CONTEXT_PACK §8.6): the runtime role reads it and nothing writes it.
-- The owner's default privileges (roles.sql) grant DML to bw_app on every new table, so they are revoked here first.
-- The ingestion jobs (INTEL-002..006) write these tables under their own role, granted by their own migration.
REVOKE ALL ON "cve_records", "kev_entries", "epss_scores", "osv_advisories", "cwe_catalogue", "owasp_mappings", "source_sync_state" FROM PUBLIC, bw_app;--> statement-breakpoint
GRANT SELECT ON "cve_records", "kev_entries", "epss_scores", "osv_advisories", "cwe_catalogue", "owasp_mappings", "source_sync_state" TO bw_app;--> statement-breakpoint
-- finding_intel is tenant data: FORCE so the owner role is subject to the tenant policy too (§8.6), DML for bw_app only.
ALTER TABLE "finding_intel" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "finding_intel" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "finding_intel" TO bw_app;
