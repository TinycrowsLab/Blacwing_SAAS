//go:build egressdeps

// This file is compiled only with -tags egressdeps (make build/test/vet/lint). It pins the
// Cedar engine chosen in CONTEXT_PACK §5 as a direct, versioned module dependency
// before the EGRESS/POLICY epics use it, without linking it into the skeleton
// binary. Remove it once real code imports the package.

package policy

import (
	// Pinned for Cedar policy evaluation (EGRESS/POLICY epics).
	_ "github.com/cedar-policy/cedar-go"
)
