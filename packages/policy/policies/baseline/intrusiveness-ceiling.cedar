// Platform baseline (POLICY-002), non-overridable.
// Enforces §8.1 (the envelope bounds all target traffic) and §8.3 (F3 standing authorisation,
// F4 intrusiveness): a request, or the test case it runs, may never exceed the envelope's
// `maxIntrusiveness` or the agent session's own `intrusivenessCeiling`.

@id("baseline.intrusiveness-ceiling.egress")
forbid (
  principal is Blackwing::AgentSession,
  action in [
    Egress::Action::"httpRequest",
    Egress::Action::"tcpConnect",
    Egress::Action::"dnsResolve"
  ],
  resource
)
when {
  context.intrusiveness.rank > context.envelope.maxIntrusiveness.rank ||
  context.intrusiveness.rank > principal.intrusivenessCeiling.rank ||
  (resource is Blackwing::TestCase &&
    (resource.class.rank > context.envelope.maxIntrusiveness.rank ||
      resource.class.rank > principal.intrusivenessCeiling.rank))
};

@id("baseline.intrusiveness-ceiling.tool")
forbid (
  principal is Blackwing::AgentSession,
  action == Tool::Action::"invoke",
  resource
)
when {
  context.intrusiveness.rank > context.envelope.maxIntrusiveness.rank ||
  context.intrusiveness.rank > principal.intrusivenessCeiling.rank ||
  (resource is Blackwing::TestCase &&
    (resource.class.rank > context.envelope.maxIntrusiveness.rank ||
      resource.class.rank > principal.intrusivenessCeiling.rank))
};
