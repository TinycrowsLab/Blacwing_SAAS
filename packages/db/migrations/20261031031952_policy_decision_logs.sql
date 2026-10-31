CREATE TABLE "policy_decision_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid,
	"action" text NOT NULL,
	"decision" text NOT NULL,
	"determining_policy_ids" text[] NOT NULL,
	"errored" boolean DEFAULT false NOT NULL,
	"latency_ms" integer NOT NULL,
	"context_digest" text NOT NULL,
	"now_utc" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_decision_logs_decision_check" CHECK ("policy_decision_logs"."decision" IN ('allow', 'deny')),
	CONSTRAINT "policy_decision_logs_latency_check" CHECK ("policy_decision_logs"."latency_ms" >= 0),
	CONSTRAINT "policy_decision_logs_digest_check" CHECK ("policy_decision_logs"."context_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "policy_decision_logs_errored_deny_check" CHECK (NOT "policy_decision_logs"."errored" OR "policy_decision_logs"."decision" = 'deny')
);
--> statement-breakpoint
ALTER TABLE "policy_decision_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "policy_decision_logs_tenant_id_idx" ON "policy_decision_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "policy_decision_logs_tenant_created_idx" ON "policy_decision_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE POLICY "policy_decision_logs_tenant_isolation" ON "policy_decision_logs" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY nor grants). Reviewed.
-- FORCE: the owner role is subject to the tenant policy too, so nothing reads across tenants.
ALTER TABLE "policy_decision_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Append-only: decisions are evidence. The app role may insert and read; it may not change or remove a row.
REVOKE ALL ON "policy_decision_logs" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "policy_decision_logs" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "policy_decision_logs" TO bw_app;
