-- DEMO-STORY (`pnpm demo` only): demo gaps. Gate 3 triage (released / dismissed / suspected findings), webhook delivery
-- result, Gate 2 operator reason, grey-box test accounts and a hash-chained demo audit ledger.
-- Hand-written like 20261105000000_demo_ai_hunt.sql (no RLS, every row carries tenant_id). Forward-only.
ALTER TABLE demo.findings
	DROP CONSTRAINT demo_findings_status_check,
	ADD CONSTRAINT demo_findings_status_check
		CHECK (status IN ('confirmed', 'suspected', 'not_confirmed', 'released', 'dismissed')),
	ADD COLUMN triaged_by uuid,
	ADD COLUMN triaged_at timestamp with time zone,
	ADD COLUMN triage_reason text,
	ADD COLUMN delivery_status text,
	ADD COLUMN delivery_detail text,
	ADD COLUMN delivered_at timestamp with time zone,
	ADD CONSTRAINT demo_findings_delivery_status_check
		CHECK (delivery_status IS NULL OR delivery_status IN ('delivered', 'failed'));
--> statement-breakpoint
-- Every row confirmed before this migration was proven by deterministic replay: auto-released, like new ones.
UPDATE demo.findings
	SET status = 'released', triaged_at = created_at,
		triage_reason = 'Auto-released: proven by deterministic replay.'
	WHERE status = 'confirmed';
--> statement-breakpoint
ALTER TABLE demo.gate2_requests ADD COLUMN decision_reason text;
--> statement-breakpoint
ALTER TABLE demo.assessment_requests ADD COLUMN test_accounts jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
CREATE TABLE demo.audit_events (
	id uuid PRIMARY KEY,
	tenant_id uuid NOT NULL,
	seq integer NOT NULL,
	actor_id uuid,
	actor_name text NOT NULL,
	action text NOT NULL,
	target_type text NOT NULL,
	target_id uuid NOT NULL,
	payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	prev_hash text NOT NULL,
	hash text NOT NULL,
	at timestamp with time zone NOT NULL,
	CONSTRAINT demo_audit_events_seq_key UNIQUE (tenant_id, seq)
);
--> statement-breakpoint
CREATE INDEX demo_audit_events_target_idx ON demo.audit_events (tenant_id, target_type, target_id, seq);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bw_app') THEN
		EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA demo TO bw_app');
		EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA demo TO bw_app');
		-- Append-only ledger: the app may read and append, never rewrite.
		EXECUTE format('REVOKE UPDATE, DELETE ON demo.audit_events FROM bw_app');
	END IF;
END
$$;
