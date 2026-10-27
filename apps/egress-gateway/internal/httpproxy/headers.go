package httpproxy

import (
	"net/http"
	"strings"
)

// hopByHop lists the headers that are meaningful for one connection only (RFC 9110
// §7.6.1) plus the proxy-specific ones. Upgrade is denied outright, but is stripped
// too as defence in depth.
var hopByHop = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
	"Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

// stripHopByHop removes hop-by-hop headers, including every header named by the
// Connection header, and the Proxy-* family. net/http has already moved
// Transfer-Encoding into Request.TransferEncoding, so framing is unaffected.
func stripHopByHop(h http.Header) {
	for _, v := range h.Values("Connection") {
		for name := range strings.SplitSeq(v, ",") {
			if name = strings.TrimSpace(name); name != "" {
				h.Del(name)
			}
		}
	}
	for _, name := range hopByHop {
		h.Del(name)
	}
	for name := range h {
		if len(name) >= 6 && strings.EqualFold(name[:6], "proxy-") {
			delete(h, name)
		}
	}
}

// hasUpgrade reports whether the request asks for a protocol switch (h2c, websocket).
func hasUpgrade(h http.Header) bool {
	if h.Get("Upgrade") != "" || h.Get("Http2-Settings") != "" {
		return true
	}
	for _, v := range h.Values("Connection") {
		for tok := range strings.SplitSeq(v, ",") {
			if strings.EqualFold(strings.TrimSpace(tok), "upgrade") {
				return true
			}
		}
	}
	return false
}
