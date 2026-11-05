-- DEMO-STORY (`pnpm demo` only): AI hunt POC. Generalises the demo schema from one pinned test case to any
-- registered URL target: asset scope and ownership proof, free-form objectives, kill/pause/cost on runs,
-- model-proposed findings (with `not_confirmed`), the full HTTP exchange log and Gate 2 requests.
-- Hand-written like 20261029200000_demo_story_schema.sql (no RLS, every row carries tenant_id). Forward-only.
ALTER TABLE demo.assets
	ADD COLUMN allowed_origins text[] NOT NULL DEFAULT '{}',
	ADD COLUMN excluded_paths text[] NOT NULL DEFAULT '{}',
	ADD COLUMN verification_token text,
	ADD COLUMN verified_by uuid,
	ADD COLUMN verified_at timestamp with time zone,
	ADD COLUMN created_by uuid;
--> statement-breakpoint
UPDATE demo.assets
	SET allowed_origins = ARRAY[substring(base_url from '^https?://[^/]+')],
		verification_method = 'owner_attestation'
	WHERE verification_method = 'lab_trust';
--> statement-breakpoint
ALTER TABLE demo.assets
	ADD CONSTRAINT demo_assets_verification_method_check
	CHECK (verification_method IS NULL OR verification_method IN ('http_token', 'owner_attestation'));
--> statement-breakpoint
ALTER TABLE demo.assessment_requests
	ALTER COLUMN test_case_id DROP NOT NULL,
	ADD COLUMN objective text NOT NULL DEFAULT '',
	ADD COLUMN cost_cap_usd numeric(8, 2) NOT NULL DEFAULT 5;
--> statement-breakpoint
ALTER TABLE demo.runs
	DROP CONSTRAINT demo_runs_state_check,
	ADD CONSTRAINT demo_runs_state_check
		CHECK (state IN ('queued', 'running', 'paused', 'completed', 'failed', 'killed')),
	ADD COLUMN kill_requested_at timestamp with time zone,
	ADD COLUMN kill_requested_by uuid,
	ADD COLUMN killed_at timestamp with time zone,
	ADD COLUMN halt_ms integer,
	ADD COLUMN paused boolean NOT NULL DEFAULT false,
	ADD COLUMN cost_usd numeric(10, 4) NOT NULL DEFAULT 0,
	ADD COLUMN summary text;
--> statement-breakpoint
ALTER TABLE demo.findings
	ALTER COLUMN test_case_id DROP NOT NULL,
	DROP CONSTRAINT demo_findings_status_check,
	ADD CONSTRAINT demo_findings_status_check CHECK (status IN ('confirmed', 'suspected', 'not_confirmed')),
	ADD COLUMN agent text,
	ADD COLUMN description text;
--> statement-breakpoint
CREATE TABLE demo.http_exchanges (
	id uuid PRIMARY KEY,
	tenant_id uuid NOT NULL,
	run_id uuid NOT NULL REFERENCES demo.runs(id),
	seq integer NOT NULL,
	agent text NOT NULL,
	method text NOT NULL,
	url text NOT NULL,
	request_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
	request_body text,
	status integer,
	response_headers jsonb,
	response_body text,
	duration_ms integer,
	outcome text NOT NULL,
	reason text,
	at timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT demo_http_exchanges_outcome_check CHECK (outcome IN ('sent', 'blocked', 'denied', 'error')),
	CONSTRAINT demo_http_exchanges_run_seq_key UNIQUE (run_id, seq)
);
--> statement-breakpoint
CREATE INDEX demo_http_exchanges_run_seq_idx ON demo.http_exchanges (run_id, seq);
--> statement-breakpoint
CREATE TABLE demo.gate2_requests (
	id uuid PRIMARY KEY,
	tenant_id uuid NOT NULL,
	run_id uuid NOT NULL REFERENCES demo.runs(id),
	agent text NOT NULL,
	method text NOT NULL,
	url text NOT NULL,
	path_key text NOT NULL,
	intrusiveness text NOT NULL,
	reason text,
	why_outside text,
	status text NOT NULL DEFAULT 'pending',
	deadline_at timestamp with time zone NOT NULL,
	decided_by uuid,
	decided_at timestamp with time zone,
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT demo_gate2_status_check CHECK (status IN ('pending', 'approved', 'denied', 'expired'))
);
--> statement-breakpoint
CREATE INDEX demo_gate2_run_idx ON demo.gate2_requests (run_id, created_at);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bw_app') THEN
		EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA demo TO bw_app');
		EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA demo TO bw_app');
	END IF;
END
$$;
