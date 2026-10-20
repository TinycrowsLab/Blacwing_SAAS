package policy

// Cross-check of the platform baseline policy set (POLICY-002) under the pinned cedar-go: every
// baseline file the TS engine loads must also parse and strictly validate here, and every policy
// in it must be a forbid, so the Go egress gateway enforces the same non-overridable floor.

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/cedar-policy/cedar-go"
	xast "github.com/cedar-policy/cedar-go/x/exp/ast"
	"github.com/cedar-policy/cedar-go/x/exp/schema/validate"
	"github.com/stretchr/testify/require"
)

const sharedBaselineDir = "../../../../packages/policy/policies/baseline"

func TestBaselineValidatesUnderCedarGo(t *testing.T) {
	r := loadSharedSchema(t)

	entries, err := os.ReadDir(filepath.Clean(sharedBaselineDir))
	require.NoError(t, err)
	var files []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".cedar") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	require.NotEmpty(t, files)

	count := 0
	for _, name := range files {
		raw, err := os.ReadFile(filepath.Join(filepath.Clean(sharedBaselineDir), name))
		require.NoError(t, err)
		ps, err := cedar.NewPolicySetFromBytes(name, raw)
		require.NoErrorf(t, err, "%s does not parse", name)
		for id, p := range ps.All() {
			count++
			require.Equalf(t, cedar.Forbid, p.Effect(), "%s/%s must be a forbid", name, id)
			require.NoErrorf(t,
				validate.New(r, validate.WithStrict()).Policy(string(id), (*xast.Policy)(p.AST())),
				"%s/%s fails strict validation", name, id)
		}
	}
	require.GreaterOrEqual(t, count, len(files))
}
