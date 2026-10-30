CREATE TABLE "audit_export_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref" text NOT NULL,
	"cursor_seq" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_export_subscriptions_kind_check" CHECK ("audit_export_subscriptions"."kind" IN ('syslog_tls', 'splunk_hec', 'webhook_hmac', 's3')),
	CONSTRAINT "audit_export_subscriptions_status_check" CHECK ("audit_export_subscriptions"."status" IN ('active', 'paused', 'error')),
	CONSTRAINT "audit_export_subscriptions_cursor_check" CHECK ("audit_export_subscriptions"."cursor_seq" >= 0),
	CONSTRAINT "audit_export_subscriptions_config_check" CHECK (jsonb_typeof("audit_export_subscriptions"."config") = 'object'),
	CONSTRAINT "audit_export_subscriptions_filters_check" CHECK (jsonb_typeof("audit_export_subscriptions"."filters") = 'object'),
	CONSTRAINT "audit_export_subscriptions_secret_ref_check" CHECK ("audit_export_subscriptions"."secret_ref" ~ '^bw-secret://[A-Za-z0-9][A-Za-z0-9_-]{0,63}/[A-Za-z0-9][A-Za-z0-9_-]{0,63}(\?v=[1-9][0-9]{0,9})?$')
);
--> statement-breakpoint
ALTER TABLE "audit_export_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "audit_export_subscriptions_tenant_status_idx" ON "audit_export_subscriptions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE POLICY "audit_export_subscriptions_tenant_isolation" ON "audit_export_subscriptions" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY, grants nor triggers). Reviewed.
-- FORCE: the owner role is subject to the tenant policy too, so nothing reads across tenants.
ALTER TABLE "audit_export_subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Grants. Default privileges give the app role all four DML rights on new tables; TRUNCATE and PUBLIC are taken back.
REVOKE ALL ON "audit_export_subscriptions" FROM PUBLIC;--> statement-breakpoint
REVOKE TRUNCATE ON "audit_export_subscriptions" FROM bw_app;--> statement-breakpoint
-- Keeps updated_at in step with changes (bw_set_updated_at: 0002_column_mixins).
CREATE TRIGGER audit_export_subscriptions_set_updated_at BEFORE UPDATE ON "audit_export_subscriptions" FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at();--> statement-breakpoint
-- The cursor only moves forward. A delivery that confirms less than the stored position, or a rewind by any
-- writer, is refused here whatever the caller does: an export must never re-send a window it already moved past
-- silently, and a rewind would hide a gap. Re-delivery after a crash is the at-least-once path, not a rewind.
CREATE FUNCTION bw_audit_export_cursor_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.cursor_seq < OLD.cursor_seq THEN
    RAISE EXCEPTION 'audit export cursor cannot move backwards (% -> %)', OLD.cursor_seq, NEW.cursor_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_export_subscriptions_cursor_guard BEFORE UPDATE OF "cursor_seq" ON "audit_export_subscriptions" FOR EACH ROW EXECUTE FUNCTION bw_audit_export_cursor_guard();
