// Platform baseline (POLICY-002), non-overridable.
// Enforces §8.6 "Tenant isolation everywhere" (F32 policy layer): principal, resource and
// request context must all belong to the same tenant, for every action.
@id("baseline.tenant-isolation")
forbid (principal, action, resource)
when {
  principal.tenantId != context.tenantId ||
  resource.tenantId != context.tenantId
};
