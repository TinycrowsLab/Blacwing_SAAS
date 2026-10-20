// Platform baseline (POLICY-002), non-overridable.
// Enforces §8.3 "`state_changing` requires an SA + Gate 1 approval and a prior reversal-journal
// entry" (F4 intrusiveness, F20 reversal journal). The envelope is only signed after Gate 1, so
// "the envelope approves state_changing" means its ceiling is at least state_changing (rank 2).
// Applies when either the request or the test case is state_changing (or above).

@id("baseline.state-changing.egress")
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
  (context.intrusiveness.rank >= 2 ||
    (resource is Blackwing::TestCase && resource.class.rank >= 2)) &&
  !(context.reversalJournalPresent && context.envelope.maxIntrusiveness.rank >= 2)
};

@id("baseline.state-changing.tool")
forbid (
  principal,
  action == Tool::Action::"invoke",
  resource
)
when {
  (context.intrusiveness.rank >= 2 ||
    (resource is Blackwing::TestCase && resource.class.rank >= 2)) &&
  !(context.reversalJournalPresent && context.envelope.maxIntrusiveness.rank >= 2)
};
