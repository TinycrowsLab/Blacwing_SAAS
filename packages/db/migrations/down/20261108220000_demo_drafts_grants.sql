-- Dev-only reverse of 20261108220000_demo_drafts_grants (refused in production; see migrate-guard.ts).
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bw_app') THEN
		EXECUTE format('REVOKE DELETE ON demo.drafts FROM bw_app');
	END IF;
END
$$;
