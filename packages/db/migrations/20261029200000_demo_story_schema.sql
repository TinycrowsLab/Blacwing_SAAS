-- DEMO-STORY (`pnpm demo` only): the demo schema behind the localhost demo story (assets, assessment requests,
-- Gate 1, runs, findings). Hand-written, not part of src/schema (drizzle does not model it), so drizzle-kit
-- generates no snapshot for it. It is read and written only when BW_DEMO_MODE=1 (apps/api/src/demo and
-- apps/worker/src/demo). It has no RLS: every row carries tenant_id and the demo API filters on it. Never
-- use this schema for real customer data. Forward-only: add a new migration instead of editing this one.
CREATE SCHEMA IF NOT EXISTS demo;
--> statement-breakpoint
CREATE TABLE demo.assets (
	id uuid PRIMARY KEY,
	tenant_id uuid NOT NULL,
	slug text NOT NULL,
	name text NOT NULL,
	base_url text NOT NULL,
	ownership_status text NOT NULL DEFAULT 'unverified',
	verification_method text,
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT demo_assets_tenant_slug_key UNIQUE (tenant_id, slug),
	CONSTRAINT demo_assets_ownership_check CHECK (ownership_status IN ('unverified', 'verified'))
);
--> statement-breakpoint
CREATE TABLE demo.assessment_requests (
	id uuid PRIMARY KEY,
	tenant_id uuid NOT NULL,
	asset_id uuid NOT NULL REFERENCES demo.assets(id),
	requester_id uuid NOT NULL,
	approver_id uuid,
	test_case_id text NOT NULL,
	scope jsonb NOT NULL,
	intrusiveness text NOT NULL,
	budget_requests integer NOT NULL,
	budget_seconds integer NOT NULL,
	status text NOT NULL DEFAULT 'pending_gate1',
	decision_reason text,
	decided_at timestamp with time zone,
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT demo_requests_status_check CHECK (status IN ('pending_gate1', 'approved', 'rejected', 'running', 'completed')),
	CONSTRAINT demo_requests_intrusiveness_check CHECK (intrusiveness IN ('passive', 'active_safe')),
	CONSTRAINT demo_requests_budget_check CHECK (budget_requests > 0 AND budget_seconds > 0),
	CONSTRAINT demo_requests_sod_check CHECK (approver_id IS NULL OR approver_id <> requester_id)
);
--> statement-breakpoint
CREATE TABLE demo.runs (
	id uuid PRIMARY KEY,
	tenant_id uuid NOT NULL,
	request_id uuid NOT NULL REFERENCES demo.assessment_requests(id),
	created_by uuid NOT NULL,
	state text NOT NULL DEFAULT 'queued',
	pins jsonb NOT NULL,
	requests_used integer NOT NULL DEFAULT 0,
	budget_requests integer NOT NULL,
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	started_at timestamp with time zone,
	finished_at timestamp with time zone,
	CONSTRAINT demo_runs_state_check CHECK (state IN ('queued', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE demo.run_events (
	id bigserial PRIMARY KEY,
	run_id uuid NOT NULL REFERENCES demo.runs(id) ON DELETE CASCADE,
	seq integer NOT NULL,
	kind text NOT NULL,
	stage text NOT NULL,
	message text NOT NULL,
	data jsonb NOT NULL DEFAULT '{}'::jsonb,
	at timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT demo_run_events_seq_key UNIQUE (run_id, seq)
);
--> statement-breakpoint
CREATE TABLE demo.findings (
	id uuid PRIMARY KEY,
	tenant_id uuid NOT NULL,
	run_id uuid NOT NULL REFERENCES demo.runs(id),
	asset_id uuid NOT NULL REFERENCES demo.assets(id),
	fingerprint text NOT NULL,
	title text NOT NULL,
	test_case_id text NOT NULL,
	class text NOT NULL,
	cwe_id text NOT NULL,
	owasp_category text NOT NULL,
	severity jsonb NOT NULL,
	location jsonb NOT NULL,
	status text NOT NULL DEFAULT 'confirmed',
	confidence numeric(4, 3) NOT NULL,
	oracle jsonb NOT NULL,
	evidence jsonb NOT NULL,
	replay jsonb NOT NULL,
	repro_curl text NOT NULL,
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT demo_findings_status_check CHECK (status IN ('confirmed', 'suspected')),
	CONSTRAINT demo_findings_fingerprint_key UNIQUE (tenant_id, fingerprint)
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bw_app') THEN
		EXECUTE format('GRANT USAGE ON SCHEMA demo TO bw_app');
		EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA demo TO bw_app');
		EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA demo TO bw_app');
	END IF;
END
$$;
