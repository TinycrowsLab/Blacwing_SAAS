-- DEMO-STORY: the app role may read, write and discard order drafts (20261108210000_demo_drafts created the table
-- without the grants, so every save was refused). Forward-only.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bw_app') THEN
		EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON demo.drafts TO bw_app');
	END IF;
END
$$;
