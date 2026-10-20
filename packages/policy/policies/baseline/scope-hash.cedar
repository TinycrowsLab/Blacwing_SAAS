// Platform baseline (POLICY-002), non-overridable.
// Enforces §8.1 / §8.9 (anti-tamper, pinned versions; F37): the envelope presented with a
// request must carry exactly the scope hash pinned on the run. Any mismatch denies egress and
// tool invocation.

@id("baseline.scope-hash.egress")
forbid (
  principal,
  action in [
    Egress::Action::"httpRequest",
    Egress::Action::"tcpConnect",
    Egress::Action::"dnsResolve"
  ],
  resource
)
when { context.envelope.scopeHash != context.pinnedScopeHash };

@id("baseline.scope-hash.tool")
forbid (
  principal,
  action == Tool::Action::"invoke",
  resource
)
when { context.envelope.scopeHash != context.pinnedScopeHash };
