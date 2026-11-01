// DEVENV-002: tenant isolation guard for the asset/surface graph (CONTEXT_PACK §5, §8.6).
// Neo4j 5 Community has no `REQUIRE n.p IS NOT NULL` (Enterprise only), so the mandatory,
// immutable tenantId is enforced by a `before`-phase APOC trigger that aborts the transaction.
// The repository layer (packages/memory) still scopes every query by tenantId; this is the
// deterministic backstop. Runs against the `system` database. Idempotent.
CALL apoc.trigger.install('neo4j', 'bw_tenant_guard',
  'CALL apoc.util.validate(
     any(n IN $createdNodes WHERE n.tenantId IS NULL OR trim(toString(n.tenantId)) = ""),
     "BW_TENANT_REQUIRED: every node must carry a non-empty tenantId", [0])
   WITH 1 AS _
   CALL apoc.util.validate(
     any(p IN coalesce($removedNodeProperties["tenantId"], []) WHERE NOT p.node IN $deletedNodes),
     "BW_TENANT_IMMUTABLE: tenantId cannot be removed", [0])
   WITH 1 AS _
   CALL apoc.util.validate(
     any(p IN coalesce($assignedNodeProperties["tenantId"], [])
         WHERE p.old IS NOT NULL AND p.old <> p.new),
     "BW_TENANT_IMMUTABLE: tenantId cannot change", [0])
   RETURN 1',
  {phase: 'before'});
