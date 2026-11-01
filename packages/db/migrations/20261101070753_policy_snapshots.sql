CREATE TABLE "policy_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"baseline_version" text NOT NULL,
	"tenant_policy_version" integer,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_snapshots_tenant_sha256_key" UNIQUE("tenant_id","snapshot_sha256"),
	CONSTRAINT "policy_snapshots_sha256_check" CHECK ("policy_snapshots"."snapshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "policy_snapshots_tenant_policy_version_check" CHECK ("policy_snapshots"."tenant_policy_version" IS NULL OR "policy_snapshots"."tenant_policy_version" >= 1),
	CONSTRAINT "policy_snapshots_object_key_check" CHECK ("policy_snapshots"."object_key" LIKE ('t/' || "policy_snapshots"."tenant_id"::text || '/policy-snapshots/%'))
);
--> statement-breakpoint
ALTER TABLE "policy_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "policy_snapshots_tenant_id_idx" ON "policy_snapshots" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "policy_snapshots_tenant_created_idx" ON "policy_snapshots" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE POLICY "policy_snapshots_tenant_isolation" ON "policy_snapshots" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY nor grants). Reviewed.
-- FORCE: the owner role is subject to the tenant policy too, so nothing reads across tenants.
ALTER TABLE "policy_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Immutable: a snapshot is evidence of what a run was pinned to. The app role may insert and read; it may not change
-- or remove a row.
REVOKE ALL ON "policy_snapshots" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "policy_snapshots" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "policy_snapshots" TO bw_app;
