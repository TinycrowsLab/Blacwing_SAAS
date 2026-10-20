//go:build egressdeps

// This file is compiled only with -tags egressdeps (make deps-check). It pins the
// data-plane libraries chosen in CONTEXT_PACK §5 as direct, versioned module
// dependencies before the EGRESS epic uses them, without linking them into the
// skeleton binary. Remove it once real code imports these packages.

package proxy

import (
	// Pinned for the HTTP/1.1 + HTTPS (MITM) forward proxy (EGRESS epic).
	_ "github.com/elazarl/goproxy"
	// Pinned for the SOCKS5 TCP proxy (EGRESS epic).
	_ "github.com/things-go/go-socks5"
)
