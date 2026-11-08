-- DEMO-STORY: emergency stop links (design 3b). A link opens /emergency/<token> without a login and can stop every
-- live run of the workspace. Only the SHA-256 of the 32-byte random token is stored, with its expiry, creator and
-- label; create, use and revoke are written to the audit ledger by the API. The optional emergency contact shown on
-- the expired-link page is a workspace setting. Hand-written like 20261108120000_demo_client_ready.sql. Forward-only.
CREATE TABLE demo.emergency_links (
	id uuid PRIMARY KEY,
	tenant_id uuid NOT NULL,
	token_hash bytea NOT NULL,
	label text,
	created_by uuid NOT NULL,
	created_by_name text NOT NULL,
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	expires_at timestamp with time zone NOT NULL,
	revoked_at timestamp with time zone,
	revoked_by uuid,
	last_used_at timestamp with time zone,
	CONSTRAINT demo_emergency_links_hash_key UNIQUE (token_hash),
	CONSTRAINT demo_emergency_links_hash_len CHECK (octet_length(token_hash) = 32),
	CONSTRAINT demo_emergency_links_expiry_check CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE INDEX demo_emergency_links_tenant_idx ON demo.emergency_links (tenant_id, expires_at);
--> statement-breakpoint
CREATE TABLE demo.workspace_settings (
	tenant_id uuid PRIMARY KEY,
	emergency_contact_name text,
	emergency_contact_phone text,
	updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bw_app') THEN
		EXECUTE format('GRANT SELECT, INSERT, UPDATE ON demo.emergency_links, demo.workspace_settings TO bw_app');
	END IF;
END
$$;
