-- TEST FIXTURE ONLY (DEVENV-011). Not a migration. Stand-in for the §7 tables the seed writes, until the
-- DB/domain epics ship their migrations. tenants, users and memberships are real migrations now (TENANT-001);
-- the rest are stand-ins that reference them. The fixture mirrors SEED_SCHEMA_CONTRACT plus the
-- §7 RLS pattern and the §8.4 SoD check, so the seed is exercised against RLS exactly as in production.
CREATE TABLE assets (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), type text NOT NULL,
  identifiers text[] NOT NULL, environment text NOT NULL, owner_user_id uuid NOT NULL REFERENCES users(id),
  verification_status text NOT NULL, verification_method text, attestation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE asset_credentials (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), asset_id uuid NOT NULL REFERENCES assets(id),
  role_name text NOT NULL, secret_ref text NOT NULL CHECK (secret_ref LIKE 'openbao://%'),
  login_recipe jsonb NOT NULL, mfa_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE standing_authorisations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), asset_ids uuid[] NOT NULL,
  scope_rules jsonb NOT NULL, max_intrusiveness text NOT NULL CHECK (max_intrusiveness <> 'destructive'),
  pre_approved_test_classes text[] NOT NULL, default_budgets jsonb NOT NULL, test_windows jsonb NOT NULL,
  valid_from timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  requester_id uuid NOT NULL REFERENCES users(id), approver_id uuid REFERENCES users(id),
  signature text, signing_key_id text, status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT standing_authorisations_sod_check CHECK (approver_id IS NULL OR approver_id <> requester_id),
  CONSTRAINT standing_authorisations_window_check CHECK (expires_at > valid_from)
);
CREATE TABLE role_matrices (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), asset_id uuid NOT NULL REFERENCES assets(id),
  name text NOT NULL, roles text[] NOT NULL, matrix jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assets', 'asset_credentials', 'standing_authorisations', 'role_matrices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
                   'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t || '_tenant_isolation', t);
  END LOOP;
END
$$;
