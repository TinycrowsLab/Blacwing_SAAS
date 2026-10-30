CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"cedar_source" text NOT NULL,
	"rule_builder_json" jsonb,
	"sha256" text NOT NULL,
	"author" uuid NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_tenant_version_key" UNIQUE("tenant_id","version"),
	CONSTRAINT "policies_version_check" CHECK ("policies"."version" >= 1),
	CONSTRAINT "policies_source_size_check" CHECK (octet_length("policies"."cedar_source") <= 262144),
	CONSTRAINT "policies_sha256_check" CHECK ("policies"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "policies_rule_builder_json_check" CHECK ("policies"."rule_builder_json" IS NULL OR jsonb_typeof("policies"."rule_builder_json") = 'object'),
	CONSTRAINT "policies_note_check" CHECK ("policies"."note" IS NULL OR length("policies"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "policies_one_active_idx" ON "policies" USING btree ("tenant_id") WHERE "policies"."active";--> statement-breakpoint
CREATE POLICY "policies_tenant_isolation" ON "policies" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY, grants nor triggers). Reviewed.
-- FORCE: the owner role is subject to the tenant policies too, so nothing reads across tenants.
ALTER TABLE "policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Grants. Default privileges give the app role all DML rights on new tables; what it must not have is taken
-- back explicitly. Versions are append-only: no UPDATE of content, no DELETE, no TRUNCATE. The only UPDATE the
-- app role holds is on the `active` pointer, and only that column.
REVOKE ALL ON "policies" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "policies" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "policies" TO bw_app;--> statement-breakpoint
GRANT UPDATE ("active") ON "policies" TO bw_app;--> statement-breakpoint
-- Immutability (POLICY-001 requirement 2, §8.11): a version is born inactive and its content never changes. The
-- only change allowed after insert is the `active` flag, which the repository moves inside one transaction.
CREATE FUNCTION bw_policies_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.active THEN
      RAISE EXCEPTION 'a policy version is created inactive; activate it explicitly'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.cedar_source IS DISTINCT FROM OLD.cedar_source
     OR NEW.rule_builder_json IS DISTINCT FROM OLD.rule_builder_json
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.author IS DISTINCT FROM OLD.author
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'policy versions are immutable; only the active pointer may change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER policies_immutable BEFORE INSERT OR UPDATE ON "policies" FOR EACH ROW EXECUTE FUNCTION bw_policies_guard();
