// Platform baseline (POLICY-002), non-overridable.
// Enforces §8.4 "Separation of duties" (F31, F13 runtime exception gate): a scope exception can
// only be raised for a decider other than its requester, so nobody approves their own exception.
@id("baseline.sod-scope-exception")
forbid (principal, action == Scope::Action::"requestException", resource)
when { context.approverId == context.requestedBy };
