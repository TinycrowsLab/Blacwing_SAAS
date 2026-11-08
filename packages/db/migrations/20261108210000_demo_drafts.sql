-- DEMO-STORY: audit-order drafts kept on the server, so a draft opened in another browser or session keeps every answer.
-- One row per draft, owned by the person who started it. `answers` is the wizard's answers as JSON (the web never
-- puts a test-account secret in it). Forward-only.
CREATE TABLE demo.drafts (
	id uuid PRIMARY KEY,
	tenant_id uuid NOT NULL,
	owner_id uuid NOT NULL,
	step integer NOT NULL,
	answers jsonb NOT NULL,
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX demo_drafts_owner_idx ON demo.drafts (tenant_id, owner_id, updated_at DESC);
