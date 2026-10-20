// Platform baseline (POLICY-002), non-overridable.
// Enforces §8.4 "Separation of duties: requester != approver for SA, Gate 1 and Gate 2"
// (F31 separation of duties, F13 Gate 2): a user can never decide a gate request they raised.
@id("baseline.sod-gate-decide")
forbid (principal is Blackwing::User, action == Gate::Action::"decide", resource)
when { principal.userId == context.requestedBy };
