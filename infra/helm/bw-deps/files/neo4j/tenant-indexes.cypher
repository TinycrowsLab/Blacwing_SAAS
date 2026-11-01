// DEVENV-002: tenantId indexes for the surface-model labels (runs against `neo4j`). Idempotent.
// Community indexes are per label; packages/memory adds new labels here when it introduces them.
CREATE INDEX bw_asset_tenant IF NOT EXISTS FOR (n:Asset) ON (n.tenantId);
CREATE INDEX bw_host_tenant IF NOT EXISTS FOR (n:Host) ON (n.tenantId);
CREATE INDEX bw_service_tenant IF NOT EXISTS FOR (n:Service) ON (n.tenantId);
CREATE INDEX bw_endpoint_tenant IF NOT EXISTS FOR (n:Endpoint) ON (n.tenantId);
CREATE INDEX bw_technology_tenant IF NOT EXISTS FOR (n:Technology) ON (n.tenantId);
CREATE INDEX bw_finding_tenant IF NOT EXISTS FOR (n:Finding) ON (n.tenantId);
// Node identity is unique per tenant, never globally.
CREATE CONSTRAINT bw_asset_tenant_id IF NOT EXISTS FOR (n:Asset) REQUIRE (n.tenantId, n.id) IS UNIQUE;
