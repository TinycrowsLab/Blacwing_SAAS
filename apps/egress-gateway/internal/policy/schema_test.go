package policy

// Cross-check of the shared Cedar schema (POLICY-001) under the pinned cedar-go: the file the
// TypeScript engine validates with cedar-wasm must also parse, resolve and validate policies
// here. Full decision parity vectors arrive with POLICY-008.

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/cedar-policy/cedar-go"
	"github.com/cedar-policy/cedar-go/types"
	xast "github.com/cedar-policy/cedar-go/x/exp/ast"
	"github.com/cedar-policy/cedar-go/x/exp/schema"
	"github.com/cedar-policy/cedar-go/x/exp/schema/resolved"
	"github.com/cedar-policy/cedar-go/x/exp/schema/validate"
	"github.com/stretchr/testify/require"
)

const sharedSchemaPath = "../../../../packages/policy/schema/blackwing.cedarschema"

func loadSharedSchema(t *testing.T) *resolved.Schema {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(sharedSchemaPath))
	require.NoError(t, err)
	var s schema.Schema
	s.SetFilename("blackwing.cedarschema")
	require.NoError(t, s.UnmarshalCedar(raw))
	r, err := s.Resolve()
	require.NoError(t, err)
	return r
}

func validatePolicy(t *testing.T, r *resolved.Schema, text string) error {
	t.Helper()
	var p cedar.Policy
	require.NoError(t, p.UnmarshalCedar([]byte(text)))
	// cedar-go/ast.Policy is a defined type over x/exp/ast.Policy, which the validator takes.
	return validate.New(r, validate.WithStrict()).Policy("p0", (*xast.Policy)(p.AST()))
}

func TestSharedSchemaResolvesUnderCedarGo(t *testing.T) {
	r := loadSharedSchema(t)

	for _, uid := range []types.EntityUID{
		types.NewEntityUID("Egress::Action", "httpRequest"),
		types.NewEntityUID("Egress::Action", "tcpConnect"),
		types.NewEntityUID("Egress::Action", "dnsResolve"),
		types.NewEntityUID("Tool::Action", "invoke"),
		types.NewEntityUID("Scope::Action", "requestException"),
		types.NewEntityUID("Policy::Action", "edit"),
		types.NewEntityUID("Gate::Action", "decide"),
	} {
		_, ok := r.Actions[uid]
		require.Truef(t, ok, "action %s missing", uid)
	}
	for _, et := range []types.EntityType{
		"Blackwing::AgentSession", "Blackwing::User", "Blackwing::ServiceAccount",
		"Blackwing::Target", "Blackwing::TestCase", "Blackwing::Run", "Blackwing::Asset",
	} {
		_, ok := r.Entities[et]
		require.Truef(t, ok, "entity type %s missing", et)
	}

	enum, ok := r.Enums["Blackwing::IntrusivenessClass"]
	require.True(t, ok)
	ids := make([]string, 0, len(enum.Values))
	for _, v := range enum.Values {
		ids = append(ids, string(v.ID))
	}
	require.Equal(t, []string{"passive", "active_safe", "state_changing", "destructive"}, ids)
}

func TestSharedSchemaValidatesPoliciesUnderCedarGo(t *testing.T) {
	r := loadSharedSchema(t)

	require.NoError(t, validatePolicy(t, r, `permit (
  principal is Blackwing::AgentSession,
  action == Egress::Action::"httpRequest",
  resource is Blackwing::Target
) when {
  resource.inScope && context.windowOpen &&
  context.nowUtc < context.envelope.expiresAt &&
  context.intrusiveness.rank <= context.envelope.maxIntrusiveness.rank
};`))

	require.Error(t, validatePolicy(t, r,
		`permit (principal, action == Egress::Action::"httpRequest", resource) when { context.notDeclared };`))
	require.Error(t, validatePolicy(t, r,
		`permit (principal is Blackwing::AgentSession, action == Egress::Action::"httpRequest", resource) when { principal.isAdmin };`))
}
