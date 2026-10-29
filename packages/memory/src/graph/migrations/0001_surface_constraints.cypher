// 0001: uniqueness constraints and indexes for the surface graph (GRAPH-002, §8.6).
//
// Every node key includes tenantId, so an idempotent upsert keyed on it cannot merge nodes across tenants.
// Neo4j Community has no property-existence constraints (NODE KEY and IS NOT NULL are Enterprise), so the
// required tenantId and runId properties are enforced in the application (GRAPH-004). The runner logs that mode.
//
// Each statement ends with ';' at the end of its line and uses IF NOT EXISTS, so a resumed run can replay a
// statement safely.

CREATE CONSTRAINT asset_key IF NOT EXISTS FOR (n:Asset) REQUIRE (n.tenantId, n.assetId) IS UNIQUE;
CREATE CONSTRAINT host_key IF NOT EXISTS FOR (n:Host) REQUIRE (n.tenantId, n.hostname) IS UNIQUE;
CREATE CONSTRAINT service_key IF NOT EXISTS FOR (n:Service) REQUIRE (n.tenantId, n.hostname, n.port, n.protocol) IS UNIQUE;
CREATE CONSTRAINT technology_key IF NOT EXISTS FOR (n:Technology) REQUIRE (n.tenantId, n.cpe) IS UNIQUE;
CREATE CONSTRAINT endpoint_key IF NOT EXISTS FOR (n:Endpoint) REQUIRE (n.tenantId, n.assetId, n.method, n.pathTemplate) IS UNIQUE;
CREATE CONSTRAINT parameter_key IF NOT EXISTS FOR (n:Parameter) REQUIRE (n.tenantId, n.endpointKey, n.name, n.location) IS UNIQUE;
CREATE CONSTRAINT role_key IF NOT EXISTS FOR (n:Role) REQUIRE (n.tenantId, n.assetId, n.roleName) IS UNIQUE;

CREATE INDEX asset_tenant_idx IF NOT EXISTS FOR (n:Asset) ON (n.tenantId);
CREATE INDEX host_tenant_idx IF NOT EXISTS FOR (n:Host) ON (n.tenantId);
CREATE INDEX service_tenant_idx IF NOT EXISTS FOR (n:Service) ON (n.tenantId);
CREATE INDEX technology_tenant_idx IF NOT EXISTS FOR (n:Technology) ON (n.tenantId);
CREATE INDEX endpoint_tenant_idx IF NOT EXISTS FOR (n:Endpoint) ON (n.tenantId);
CREATE INDEX parameter_tenant_idx IF NOT EXISTS FOR (n:Parameter) ON (n.tenantId);
CREATE INDEX role_tenant_idx IF NOT EXISTS FOR (n:Role) ON (n.tenantId);

CREATE INDEX endpoint_asset_idx IF NOT EXISTS FOR (n:Endpoint) ON (n.assetId);
CREATE INDEX service_port_idx IF NOT EXISTS FOR (n:Service) ON (n.port);
CREATE INDEX technology_name_idx IF NOT EXISTS FOR (n:Technology) ON (n.name);
