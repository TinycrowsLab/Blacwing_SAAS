// 0002: uniqueness for the run and observation sub-model of the surface graph (GRAPH-007, §8.6).
//
// Each run is one (:Run) node per tenant, and each (run, natural key, tool) contributes one (:Observation) node, so
// concurrent upserts from two sandboxes converge on one node each. As in 0001, Neo4j Community has no property-
// existence constraints, so the required tenantId and runId are enforced in the application (GRAPH-004).
//
// Each statement ends with ';' at the end of its line and uses IF NOT EXISTS, so a resumed run can replay it safely.

CREATE CONSTRAINT run_key IF NOT EXISTS FOR (n:Run) REQUIRE (n.tenantId, n.runId) IS UNIQUE;
CREATE CONSTRAINT observation_key IF NOT EXISTS FOR (n:Observation) REQUIRE (n.tenantId, n.observationKey) IS UNIQUE;
CREATE INDEX run_tenant_idx IF NOT EXISTS FOR (n:Run) ON (n.tenantId);
CREATE INDEX observation_tenant_idx IF NOT EXISTS FOR (n:Observation) ON (n.tenantId);
