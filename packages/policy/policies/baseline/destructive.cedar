// Platform baseline (POLICY-002), non-overridable.
// Enforces §8.3 "Destructive class is never allowed" (F4 intrusiveness, CONTEXT_PACK §3.5):
// no egress, tool invocation or scope-exception request may run at the `destructive` class,
// whether the class comes from the request (context) or from the test case being run.
// The rank test is defence in depth should a value's level and rank ever disagree.

@id("baseline.destructive.egress")
forbid (
  principal,
  action in [
    Egress::Action::"httpRequest",
    Egress::Action::"tcpConnect",
    Egress::Action::"dnsResolve"
  ],
  resource
)
when {
  context.intrusiveness.level == Blackwing::IntrusivenessClass::"destructive" ||
  context.intrusiveness.rank >= 3 ||
  (resource is Blackwing::TestCase &&
    (resource.class.level == Blackwing::IntrusivenessClass::"destructive" ||
      resource.class.rank >= 3))
};

@id("baseline.destructive.tool")
forbid (
  principal,
  action == Tool::Action::"invoke",
  resource
)
when {
  context.intrusiveness.level == Blackwing::IntrusivenessClass::"destructive" ||
  context.intrusiveness.rank >= 3 ||
  (resource is Blackwing::TestCase &&
    (resource.class.level == Blackwing::IntrusivenessClass::"destructive" ||
      resource.class.rank >= 3))
};

@id("baseline.destructive.scope-exception")
forbid (
  principal,
  action == Scope::Action::"requestException",
  resource
)
when {
  context.intrusiveness.level == Blackwing::IntrusivenessClass::"destructive" ||
  context.intrusiveness.rank >= 3 ||
  (resource is Blackwing::TestCase &&
    (resource.class.level == Blackwing::IntrusivenessClass::"destructive" ||
      resource.class.rank >= 3))
};
