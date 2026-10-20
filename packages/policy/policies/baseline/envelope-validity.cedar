// Platform baseline (POLICY-002), non-overridable.
// Enforces §8.1 "No target traffic without a valid, unexpired envelope; expiry mid-run means an
// immediate block" (F3 standing authorisation, F13 runtime context). The validity interval is
// half-open: allowed from `validFrom` (inclusive) until `expiresAt` (exclusive), so a request at
// exactly `expiresAt` is denied. A closed testing window denies as well.

@id("baseline.envelope-validity.egress")
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
  context.nowUtc < context.envelope.validFrom ||
  context.nowUtc >= context.envelope.expiresAt ||
  !context.windowOpen
};

@id("baseline.envelope-validity.tool")
forbid (
  principal,
  action == Tool::Action::"invoke",
  resource
)
when {
  context.nowUtc < context.envelope.validFrom ||
  context.nowUtc >= context.envelope.expiresAt ||
  !context.windowOpen
};
