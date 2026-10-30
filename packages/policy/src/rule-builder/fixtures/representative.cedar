@id("tenant.allow-read-in-scope")
@source("rule-builder")
@description("Passive reads of in-scope hosts")
permit (
  principal is Blackwing::AgentSession,
  action == Egress::Action::"httpRequest",
  resource is Blackwing::Target
)
when {
  (["api.example.test", "static.example.test"].contains(resource.host)) &&
  (resource.inScope == true) &&
  (context.intrusiveness.rank <= 1) &&
  (context.isPrivateRange == false)
};

@id("tenant.block-admin-paths")
@source("rule-builder")
@description("Never touch admin paths */ \"quoted\" and unicode: café, 東京")
forbid (
  principal is Blackwing::AgentSession,
  action == Egress::Action::"httpRequest",
  resource is Blackwing::Target
)
when {
  ((resource.path == "/admin") || (resource.path == "/internal"))
};

@id("tenant.allow-passive-probe")
@source("rule-builder")
permit (
  principal is Blackwing::AgentSession,
  action == Tool::Action::"invoke",
  resource is Blackwing::TestCase
)
when {
  (resource.class.level == Blackwing::IntrusivenessClass::"passive") &&
  (resource.class.rank <= 1) &&
  (context.toolName == "http_probe")
};

@id("tenant.approver-gates")
@source("rule-builder")
permit (
  principal is Blackwing::User,
  action == Gate::Action::"decide",
  resource is Blackwing::Run
)
when {
  (principal.roles.contains("approver")) &&
  (["gate1", "gate2"].contains(context.gate))
};
