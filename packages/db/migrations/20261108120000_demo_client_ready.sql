-- DEMO-STORY: client-ready fixes. Single-use Gate 1 approvals and plan versions, Gate 2 ask details, cross-run
-- finding identity and finding retests. Hand-written like 20261105120000_demo_gaps.sql. Forward-only.
ALTER TABLE demo.assessment_requests
	DROP CONSTRAINT demo_requests_status_check,
	ADD CONSTRAINT demo_requests_status_check
		CHECK (status IN ('pending_gate1', 'approved', 'rejected', 'running', 'completed', 'failed', 'killed')),
	ADD COLUMN version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
-- Close approvals that a killed or failed run handed back (they could start a second run without a new decision).
UPDATE demo.assessment_requests r SET status = ru.state
	FROM demo.runs ru
	WHERE ru.request_id = r.id AND ru.state IN ('failed', 'killed') AND r.status IN ('approved', 'running');
--> statement-breakpoint
ALTER TABLE demo.gate2_requests
	ADD COLUMN request_body text,
	ADD COLUMN as_role text,
	ADD COLUMN close_reason text;
--> statement-breakpoint
ALTER TABLE demo.findings ADD COLUMN identity_key text;
--> statement-breakpoint
CREATE INDEX demo_findings_identity_idx ON demo.findings (tenant_id, identity_key, created_at)
	WHERE identity_key IS NOT NULL;
--> statement-breakpoint
CREATE TABLE demo.finding_retests (
	id uuid PRIMARY KEY,
	tenant_id uuid NOT NULL,
	finding_id uuid NOT NULL REFERENCES demo.findings(id),
	requested_by uuid NOT NULL,
	status text NOT NULL DEFAULT 'queued',
	result text,
	detail jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	started_at timestamp with time zone,
	finished_at timestamp with time zone,
	CONSTRAINT demo_finding_retests_status_check CHECK (status IN ('queued', 'running', 'done', 'failed')),
	CONSTRAINT demo_finding_retests_result_check
		CHECK (result IS NULL OR result IN ('still_present', 'fixed', 'inconclusive'))
);
--> statement-breakpoint
CREATE INDEX demo_finding_retests_finding_idx ON demo.finding_retests (finding_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX demo_finding_retests_open_key ON demo.finding_retests (finding_id)
	WHERE status IN ('queued', 'running');
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bw_app') THEN
		EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA demo TO bw_app');
		EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA demo TO bw_app');
		EXECUTE format('REVOKE UPDATE, DELETE ON demo.audit_events FROM bw_app');
	END IF;
END
$$;
