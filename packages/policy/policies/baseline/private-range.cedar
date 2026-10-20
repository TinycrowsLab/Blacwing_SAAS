// Platform baseline (POLICY-002), non-overridable.
// Enforces §8.2 "private/link-local/metadata ranges are blocked unless explicitly in scope"
// (F11 scoped egress; SSRF-to-metadata, CWE-918). `isPrivateRange`, `isMetadata` and
// `saIncludesRange` are computed in code. Being in scope is not enough: the signed SA must
// list that private or metadata range explicitly (defence in depth against a broad scope rule).

@id("baseline.private-range.egress")
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
  (context.isPrivateRange || context.isMetadata) &&
  !(resource is Blackwing::Target && resource.inScope && context.saIncludesRange)
};

@id("baseline.private-range.tool")
forbid (
  principal,
  action == Tool::Action::"invoke",
  resource
)
when {
  (context.isPrivateRange || context.isMetadata) &&
  !(resource is Blackwing::Target && resource.inScope && context.saIncludesRange)
};
