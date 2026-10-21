CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"action" text NOT NULL,
	"severity" text NOT NULL,
	"actor" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata_ref" jsonb,
	"trace_id" text,
	"run_id" uuid,
	"ip" text,
	"user_agent" text,
	"prev_hash" "bytea",
	"hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_tenant_seq_key" UNIQUE("tenant_id","seq"),
	CONSTRAINT "audit_events_seq_check" CHECK ("audit_events"."seq" >= 1),
	CONSTRAINT "audit_events_severity_check" CHECK ("audit_events"."severity" IN ('info', 'notice', 'warning', 'critical')),
	CONSTRAINT "audit_events_outcome_check" CHECK ("audit_events"."outcome" IN ('success', 'failure', 'denied')),
	CONSTRAINT "audit_events_hash_length_check" CHECK (octet_length("audit_events"."hash") = 32),
	CONSTRAINT "audit_events_prev_hash_check" CHECK (("audit_events"."seq" = 1) = ("audit_events"."prev_hash" IS NULL) AND ("audit_events"."prev_hash" IS NULL OR octet_length("audit_events"."prev_hash") = 32)),
	CONSTRAINT "audit_events_actor_check" CHECK (jsonb_typeof("audit_events"."actor") = 'object'),
	CONSTRAINT "audit_events_target_check" CHECK (jsonb_typeof("audit_events"."target") = 'object'),
	CONSTRAINT "audit_events_metadata_check" CHECK (jsonb_typeof("audit_events"."metadata") = 'object')
);
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "audit_events_tenant_occurred_at_idx" ON "audit_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_action_idx" ON "audit_events" USING btree ("tenant_id","action");--> statement-breakpoint
CREATE INDEX "audit_events_run_id_idx" ON "audit_events" USING btree ("run_id");--> statement-breakpoint
CREATE POLICY "audit_events_tenant_isolation" ON "audit_events" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY, grants nor triggers). Reviewed.
-- Audit ledger (AUDIT-002, F34, CONTEXT_PACK §8.6, §8.8): append-only hash chain per tenant.
-- FORCE: the owner role is subject to the tenant policy too.
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Grants: the app role may only read and append. Default privileges grant it all four DML rights on
-- new tables, so they are taken back explicitly; TRUNCATE and PUBLIC are revoked as well.
REVOKE ALL ON "audit_events" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_events" TO bw_app;--> statement-breakpoint
-- Defence in depth beyond the grants: nothing (the owner included) may update, delete or truncate
-- the ledger. Statement level, so it also fires when RLS or a WHERE clause matches no row.
CREATE FUNCTION bw_audit_events_no_mutate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_no_mutate BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION bw_audit_events_no_mutate();--> statement-breakpoint
-- Chain head of the current tenant, taking the per-tenant advisory lock first (held to the end of
-- the transaction). The AUDIT-003 helper calls this, computes seq = head_seq + 1 and the hash, and
-- inserts in the same transaction, so concurrent writers of one tenant serialise and never fork the
-- chain; other tenants hash to other locks and do not contend. Empty chain: head_seq 0, head_hash NULL.
-- SECURITY INVOKER: the read runs under the caller's RLS, and a tenant other than the session's is
-- refused so the lock cannot be used to stall another tenant.
CREATE FUNCTION bw_audit_chain_head(p_tenant_id uuid) RETURNS TABLE (head_seq bigint, head_hash bytea)
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM current_setting('app.tenant_id')::uuid THEN
    RAISE EXCEPTION 'audit chain head requested for a tenant other than the session tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_tenant_id::text));
  RETURN QUERY
    SELECT e.seq, e.hash FROM public.audit_events e
     WHERE e.tenant_id = p_tenant_id ORDER BY e.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::bigint, NULL::bytea;
  END IF;
END
$$;--> statement-breakpoint
-- Chain linkage guard for every insert, whoever issues it: under the same advisory lock, the new row
-- must be exactly head + 1 and point at the head's hash (genesis: seq 1, prev_hash NULL). A raw or
-- racing insert that would fork or gap the chain is rejected; unique (tenant_id, seq) is the backstop.
-- The hash itself (SHA-256 over JCS) is computed and verified in TypeScript, not here.
CREATE FUNCTION bw_audit_events_chain_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  head_seq bigint;
  head_hash bytea;
BEGIN
  -- BEFORE triggers run ahead of the RLS WITH CHECK, so refuse a foreign tenant row here with the
  -- same error and message Postgres uses for a policy violation.
  IF NEW.tenant_id IS DISTINCT FROM current_setting('app.tenant_id')::uuid THEN
    RAISE EXCEPTION 'new row violates row-level security policy for table "audit_events"'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));
  SELECT e.seq, e.hash INTO head_seq, head_hash FROM public.audit_events e
   WHERE e.tenant_id = NEW.tenant_id ORDER BY e.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    head_seq := 0;
    head_hash := NULL;
  END IF;
  IF NEW.seq IS DISTINCT FROM head_seq + 1 OR NEW.prev_hash IS DISTINCT FROM head_hash THEN
    RAISE EXCEPTION 'audit chain violation: row does not extend the tenant chain'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_chain_check BEFORE INSERT ON "audit_events" FOR EACH ROW EXECUTE FUNCTION bw_audit_events_chain_check();
