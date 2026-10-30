// 0003: uniqueness and tenant indexes for the spec-ingestion node kinds (INGEST-001, §8.6, §8.9).
//
// Spec documents, schema objects, auth schemes, source routes and config items are keyed by their natural key, which
// already carries the tenant and the source artefact. The constraint is on (tenantId, naturalKey), so a concurrent
// MERGE from two importers of one artefact converges on one node. As in 0001, Neo4j Community has no property-
// existence constraints, so the required tenantId is enforced in the application (GRAPH-004).
//
// Each statement ends with ';' at the end of its line and uses IF NOT EXISTS, so a resumed run can replay it safely.

CREATE CONSTRAINT spec_document_key IF NOT EXISTS FOR (n:SpecDocument) REQUIRE (n.tenantId, n.naturalKey) IS UNIQUE;
CREATE CONSTRAINT schema_object_key IF NOT EXISTS FOR (n:SchemaObject) REQUIRE (n.tenantId, n.naturalKey) IS UNIQUE;
CREATE CONSTRAINT auth_scheme_key IF NOT EXISTS FOR (n:AuthScheme) REQUIRE (n.tenantId, n.naturalKey) IS UNIQUE;
CREATE CONSTRAINT source_route_key IF NOT EXISTS FOR (n:SourceRoute) REQUIRE (n.tenantId, n.naturalKey) IS UNIQUE;
CREATE CONSTRAINT config_item_key IF NOT EXISTS FOR (n:ConfigItem) REQUIRE (n.tenantId, n.naturalKey) IS UNIQUE;

CREATE INDEX spec_document_tenant_idx IF NOT EXISTS FOR (n:SpecDocument) ON (n.tenantId);
CREATE INDEX schema_object_tenant_idx IF NOT EXISTS FOR (n:SchemaObject) ON (n.tenantId);
CREATE INDEX auth_scheme_tenant_idx IF NOT EXISTS FOR (n:AuthScheme) ON (n.tenantId);
CREATE INDEX source_route_tenant_idx IF NOT EXISTS FOR (n:SourceRoute) ON (n.tenantId);
CREATE INDEX config_item_tenant_idx IF NOT EXISTS FOR (n:ConfigItem) ON (n.tenantId);
