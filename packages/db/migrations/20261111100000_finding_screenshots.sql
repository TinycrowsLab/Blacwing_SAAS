-- DEMO-STORY: proof screenshots (PNG) of a proven finding, one for the probe and one for the control, taken by the
-- worker's headless browser after the validator confirms. Stored inline (a few hundred KB each at most); read through
-- the API, tenant-scoped. Forward-only.
CREATE TABLE demo.finding_screenshots (
	finding_id uuid NOT NULL REFERENCES demo.findings(id) ON DELETE CASCADE,
	tenant_id uuid NOT NULL,
	kind text NOT NULL,
	png bytea NOT NULL,
	width integer NOT NULL,
	height integer NOT NULL,
	mode text NOT NULL,
	request_method text NOT NULL,
	request_url text NOT NULL,
	response_status integer,
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	PRIMARY KEY (finding_id, kind),
	CONSTRAINT demo_finding_screenshots_kind_check CHECK (kind IN ('probe', 'control')),
	CONSTRAINT demo_finding_screenshots_mode_check CHECK (mode IN ('navigated', 'rendered')),
	CONSTRAINT demo_finding_screenshots_size_check CHECK (octet_length(png) <= 2097152)
);
--> statement-breakpoint
CREATE INDEX demo_finding_screenshots_tenant_idx ON demo.finding_screenshots (tenant_id, finding_id);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bw_app') THEN
		EXECUTE format('GRANT SELECT, INSERT, UPDATE ON demo.finding_screenshots TO bw_app');
	END IF;
END
$$;
