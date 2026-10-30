// Platform resource-level baseline (#345). Deny by default: a decision needs a permit below, and no
// permit can override a forbid. Staff roles mirror the asset policy in apps/api/src/assets/policy.ts.
// Each policy is annotated with a unique @id("authz.<name>"), which the decision log reports as the reason.

@id("authz.tenant_isolation")
forbid (principal, action, resource)
unless { principal.tenantId == resource.tenantId };

@id("authz.asset_read_owner")
permit (principal is User, action == Action::"asset:read", resource is Asset)
when { principal.userId == resource.ownerUserId };

@id("authz.asset_read_staff")
permit (principal is User, action == Action::"asset:read", resource is Asset)
when { principal.roles.contains("appsec_engineer") || principal.roles.contains("org_admin") };

@id("authz.asset_read_service_account")
permit (principal is ServiceAccount, action == Action::"asset:read", resource is Asset)
when { principal.scopes.contains("asset:read") && principal.assetIds.contains(resource.assetId) };

@id("authz.asset_write_owner")
permit (principal is User, action == Action::"asset:write", resource is Asset)
when { principal.userId == resource.ownerUserId };

@id("authz.asset_write_staff")
permit (principal is User, action == Action::"asset:write", resource is Asset)
when { principal.roles.contains("appsec_engineer") || principal.roles.contains("org_admin") };

// An asset_owner may approve a standing authorisation only when they own every asset it covers.
// An empty owner set never equals [userId], so an SA with no resolved owners is denied.
@id("authz.sa_approve_asset_owner")
permit (principal is User, action == Action::"sa:approve", resource is StandingAuthorisation)
when { principal.roles.contains("asset_owner") && resource.assetOwnerIds == [principal.userId] };

// Separation of duties (RBAC-011): the requester may never approve their own standing authorisation.
@id("authz.sa_approve_separation_of_duties")
forbid (principal is User, action == Action::"sa:approve", resource is StandingAuthorisation)
when { principal.userId == resource.requesterId };

@id("authz.run_read_owner")
permit (principal is User, action == Action::"run:read", resource is Run)
when { principal.userId == resource.ownerUserId };

@id("authz.run_read_staff")
permit (principal is User, action == Action::"run:read", resource is Run)
when { principal.roles.contains("appsec_engineer") || principal.roles.contains("org_admin") };

@id("authz.finding_read_owner")
permit (principal is User, action == Action::"finding:read", resource is Finding)
when { principal.userId == resource.ownerUserId };

@id("authz.finding_read_staff")
permit (principal is User, action == Action::"finding:read", resource is Finding)
when { principal.roles.contains("appsec_engineer") || principal.roles.contains("org_admin") };
