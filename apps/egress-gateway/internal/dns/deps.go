//go:build egressdeps

// This file is compiled only with -tags egressdeps (make build/test/vet/lint). It pins the
// DNS library chosen in CONTEXT_PACK §5 as a direct, versioned module dependency
// before the EGRESS epic uses it, without linking it into the skeleton binary.
// Remove it once real code imports the package.

package dns

import (
	// Pinned for the scoped DNS resolver (EGRESS epic).
	_ "github.com/miekg/dns"
)
