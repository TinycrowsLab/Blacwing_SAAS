package dnsresolve

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"time"

	"github.com/miekg/dns"
)

// answerTTL is the TTL on listener answers. It is short because the pin, not the
// client cache, is authoritative.
const answerTTL = 5

// KeyFunc maps a DNS client address to the pin key (run or connection) it belongs
// to. ok=false means the client is unknown and its query is refused.
type KeyFunc func(remote net.Addr) (pinKey string, ok bool)

// Handler returns the DNS handler for the optional GATEWAY_DNS_ADDR listener. It
// answers only A and AAAA queries for in-scope names from the pin, and never
// recurses for anything else: out-of-scope names, blocked ranges, other query types
// and unknown clients get REFUSED without any upstream query.
func (r *Resolver) Handler(key KeyFunc) dns.Handler {
	return dns.HandlerFunc(func(w dns.ResponseWriter, req *dns.Msg) {
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.RecursionAvailable = true
		r.answer(resp, req, w.RemoteAddr(), key)
		_ = w.WriteMsg(resp) // a failed write has nobody left to tell
	})
}

func (r *Resolver) answer(resp, req *dns.Msg, remote net.Addr, key KeyFunc) {
	if req.Opcode != dns.OpcodeQuery || len(req.Question) != 1 {
		resp.Rcode = dns.RcodeRefused
		return
	}
	q := req.Question[0]
	if q.Qclass != dns.ClassINET || (q.Qtype != dns.TypeA && q.Qtype != dns.TypeAAAA) {
		resp.Rcode = dns.RcodeRefused
		return
	}
	pinKey, ok := key(remote)
	if !ok {
		resp.Rcode = dns.RcodeRefused
		return
	}
	ip, err := r.Resolve(context.Background(), q.Name, pinKey)
	switch {
	case errors.Is(err, ErrHostOutOfScope), errors.Is(err, ErrBlockedRange):
		resp.Rcode = dns.RcodeRefused
		return
	case err != nil:
		resp.Rcode = dns.RcodeServerFailure
		return
	}
	addr, _ := netip.AddrFromSlice(ip)
	addr = addr.Unmap()
	hdr := dns.RR_Header{Name: q.Name, Class: dns.ClassINET, Ttl: answerTTL}
	switch {
	case q.Qtype == dns.TypeA && addr.Is4():
		hdr.Rrtype = dns.TypeA
		resp.Answer = append(resp.Answer, &dns.A{Hdr: hdr, A: addr.AsSlice()})
	case q.Qtype == dns.TypeAAAA && addr.Is6():
		hdr.Rrtype = dns.TypeAAAA
		resp.Answer = append(resp.Answer, &dns.AAAA{Hdr: hdr, AAAA: addr.AsSlice()})
	}
	// Otherwise the pin is the other family: NOERROR with no answer (NODATA).
}

// Serve runs the UDP and TCP listeners on addr until ctx is cancelled or one fails.
func (r *Resolver) Serve(ctx context.Context, addr string, key KeyFunc) error {
	h := r.Handler(key)
	servers := []*dns.Server{
		{Addr: addr, Net: "udp", Handler: h},
		{Addr: addr, Net: "tcp", Handler: h},
	}
	errc := make(chan error, len(servers))
	for _, s := range servers {
		go func() { errc <- s.ListenAndServe() }()
	}
	var err error
	select {
	case <-ctx.Done():
	case err = <-errc:
	}
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.ShutdownContext(sctx) // "not started" is expected when the other side failed first
	}
	return err
}
