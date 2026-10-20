-- Test-only schema: one tenant table following the §7 RLS pattern, used by the withPostgres
-- integration tests. The real schema belongs to packages/db.
CREATE TABLE rls_probe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rls_probe_tenant_id_idx ON rls_probe (tenant_id);

ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_probe FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_probe_tenant_isolation ON rls_probe
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
