// Platform baseline (POLICY-002), non-overridable.
// Enforces §8.2 "egress fails closed" / default-deny scope (F11 scoped egress, F1 scoping):
// a Target the SCOPE-002 matcher did not place in scope (`inScope == false`, computed in code)
// is never reachable, by egress or by a tool invocation aimed at it.

@id("baseline.out-of-scope.egress")
forbid (
  principal,
  action in [
    Egress::Action::"httpRequest",
    Egress::Action::"tcpConnect",
    Egress::Action::"dnsResolve"
  ],
  resource
)
when { resource is Blackwing::Target && !resource.inScope };

@id("baseline.out-of-scope.tool")
forbid (
  principal,
  action == Tool::Action::"invoke",
  resource
)
when { resource is Blackwing::Target && !resource.inScope };
