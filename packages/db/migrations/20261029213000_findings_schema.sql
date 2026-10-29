CREATE TABLE "finding_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"occurrence_status" text NOT NULL,
	"evidence_chain_head" text,
	"detected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_occurrences_status_check" CHECK (length("finding_occurrences"."occurrence_status") BETWEEN 1 AND 120),
	CONSTRAINT "finding_occurrences_evidence_chain_head_check" CHECK ("finding_occurrences"."evidence_chain_head" IS NULL OR "finding_occurrences"."evidence_chain_head" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "finding_occurrences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"public_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"class" text NOT NULL,
	"cwe_id" text,
	"owasp_category" text,
	"severity" jsonb,
	"asset_id" uuid NOT NULL,
	"location" jsonb NOT NULL,
	"status" text NOT NULL,
	"baseline_status" text,
	"run_id" uuid NOT NULL,
	"first_seen_run_id" uuid NOT NULL,
	"last_seen_run_id" uuid NOT NULL,
	"confidence" numeric(4, 3),
	"accepted_risk" jsonb,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "findings_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "findings_public_id_check" CHECK (starts_with("findings"."public_id", 'fnd_') AND length("findings"."public_id") > 4),
	CONSTRAINT "findings_fingerprint_check" CHECK ("findings"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "findings_title_check" CHECK (length("findings"."title") BETWEEN 1 AND 200),
	CONSTRAINT "findings_class_check" CHECK (length("findings"."class") BETWEEN 1 AND 120),
	CONSTRAINT "findings_cwe_id_check" CHECK ("findings"."cwe_id" IS NULL OR "findings"."cwe_id" ~ '^CWE-[1-9][0-9]{0,4}$'),
	CONSTRAINT "findings_owasp_category_check" CHECK ("findings"."owasp_category" IS NULL OR length("findings"."owasp_category") BETWEEN 1 AND 120),
	CONSTRAINT "findings_severity_check" CHECK ("findings"."severity" IS NULL OR (jsonb_typeof("findings"."severity") = 'object' AND octet_length("findings"."severity"::text) <= 4096)),
	CONSTRAINT "findings_location_check" CHECK (jsonb_typeof("findings"."location") = 'object' AND ("findings"."location"->>'urlTemplate' IS NOT NULL OR "findings"."location"->>'file' IS NOT NULL) AND octet_length("findings"."location"::text) <= 8192),
	CONSTRAINT "findings_status_check" CHECK ("findings"."status" IN ('candidate', 'validating', 'confirmed', 'suspected', 'released', 'rejected_false_positive', 'duplicate', 'accepted_risk', 'fixed', 'returned')),
	CONSTRAINT "findings_baseline_status_check" CHECK ("findings"."baseline_status" IS NULL OR "findings"."baseline_status" IN ('new', 'open', 'fixed', 'returned', 'not_retested')),
	CONSTRAINT "findings_confidence_check" CHECK ("findings"."confidence" IS NULL OR ("findings"."confidence" >= 0 AND "findings"."confidence" <= 1)),
	CONSTRAINT "findings_released_check" CHECK ("findings"."status" NOT IN ('released', 'fixed', 'returned') OR ("findings"."released_by" IS NOT NULL AND "findings"."released_at" IS NOT NULL)),
	CONSTRAINT "findings_accepted_risk_check" CHECK (("findings"."status" = 'accepted_risk') = ("findings"."accepted_risk" IS NOT NULL)),
	CONSTRAINT "findings_accepted_risk_object_check" CHECK ("findings"."accepted_risk" IS NULL OR jsonb_typeof("findings"."accepted_risk") = 'object'),
	CONSTRAINT "findings_state_version_check" CHECK ("findings"."state_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_finding_fk" FOREIGN KEY ("tenant_id","finding_id") REFERENCES "public"."findings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_occurrences_tenant_id_idx" ON "finding_occurrences" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_occurrences_finding_id_run_id_key" ON "finding_occurrences" USING btree ("finding_id","run_id");--> statement-breakpoint
CREATE INDEX "findings_tenant_id_idx" ON "findings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_public_id_key" ON "findings" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_tenant_id_fingerprint_key" ON "findings" USING btree ("tenant_id","fingerprint");--> statement-breakpoint
CREATE INDEX "findings_tenant_id_status_idx" ON "findings" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE POLICY "finding_occurrences_tenant_isolation" ON "finding_occurrences" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "findings_tenant_isolation" ON "findings" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY, grants nor triggers). Reviewed.
-- FORCE: the owner role is subject to the tenant policy too, so nothing reads across tenants.
ALTER TABLE "findings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finding_occurrences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The runtime role gets SELECT/INSERT/UPDATE only: findings are never deleted (lifecycle, not removal).
REVOKE ALL ON "findings", "finding_occurrences" FROM PUBLIC;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "findings", "finding_occurrences" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "findings" TO bw_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "finding_occurrences" TO bw_app;--> statement-breakpoint
-- Keeps updated_at in step with every write (bw_set_updated_at: 0002_column_mixins).
CREATE TRIGGER findings_set_updated_at BEFORE UPDATE ON findings FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at();--> statement-breakpoint
CREATE TRIGGER finding_occurrences_set_updated_at BEFORE UPDATE ON finding_occurrences FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at();
