CREATE TABLE "virtual_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"key_prefix" text NOT NULL,
	"key_sha256" "bytea" NOT NULL,
	"scope" jsonb NOT NULL,
	"budget_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"persona" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "virtual_keys_sha256_length_check" CHECK (octet_length("virtual_keys"."key_sha256") = 32),
	CONSTRAINT "virtual_keys_prefix_check" CHECK ("virtual_keys"."key_prefix" ~ '^bwk_[0-9A-Za-z]{8}$'),
	CONSTRAINT "virtual_keys_expiry_check" CHECK ("virtual_keys"."expires_at" > "virtual_keys"."created_at"),
	CONSTRAINT "virtual_keys_persona_check" CHECK ("virtual_keys"."persona" ~ '^[a-z][a-z0-9-]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "virtual_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_keys_key_sha256_key" ON "virtual_keys" USING btree ("key_sha256");--> statement-breakpoint
CREATE INDEX "virtual_keys_tenant_id_idx" ON "virtual_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "virtual_keys_tenant_run_idx" ON "virtual_keys" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "virtual_keys_key_prefix_idx" ON "virtual_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE POLICY "virtual_keys_tenant_isolation" ON "virtual_keys" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "virtual_keys_resolve_by_hash" ON "virtual_keys" AS PERMISSIVE FOR SELECT TO public USING ("virtual_keys"."key_sha256" = decode(current_setting('app.virtual_key_sha256', true), 'hex'));
--> statement-breakpoint
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY, grants nor triggers). Reviewed.
-- FORCE: the owner role is subject to the tenant policy too, so nothing reads across tenants.
ALTER TABLE "virtual_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The runtime role mints, validates and stamps keys but never deletes them: a revoked key stays for the audit trail.
REVOKE ALL ON "virtual_keys" FROM PUBLIC;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "virtual_keys" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "virtual_keys" TO bw_app;--> statement-breakpoint
-- Keeps updated_at in step with every write (bw_set_updated_at: 0002_column_mixins).
CREATE TRIGGER virtual_keys_set_updated_at BEFORE UPDATE ON virtual_keys FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at();
