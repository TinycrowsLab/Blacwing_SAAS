package netguard_test

import (
	"errors"
	"net"
	"net/netip"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/netguard"
)

type scopeIPs []netip.Prefix

func (s scopeIPs) IPInScope(ip netip.Addr) bool {
	for _, p := range s {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

func TestBlockedRanges(t *testing.T) {
	for _, s := range []string{
		"10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "0.0.0.0",
		"169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "224.0.0.1",
		"255.255.255.255", "240.0.0.1", "198.19.0.1", "192.0.0.8",
		"::", "::1", "fd00:ec2::254", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::a00:1",
		"64:ff9b:1::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:127.0.0.1",
		"fe80::1%eth0", "64:ff9b::a9fe:a9fe",
	} {
		assert.True(t, netguard.IsBlocked(netip.MustParseAddr(s), nil), s)
	}
	for _, s := range []string{
		"93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1",
		"2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808",
	} {
		assert.False(t, netguard.IsBlocked(netip.MustParseAddr(s), nil), s)
	}
	assert.True(t, netguard.IsBlocked(netip.Addr{}, nil), "invalid fails closed")
}

func TestVerdictReasons(t *testing.T) {
	g := netguard.Default()
	v := g.Check(netip.MustParseAddr("169.254.169.254"), nil)
	assert.Equal(t, netguard.ReasonMetadata, v.Reason)
	assert.Equal(t, "169.254.169.254/32", v.CIDR.String())
	v = g.Check(netip.MustParseAddr("fd00:ec2::254"), nil)
	assert.Equal(t, netguard.ReasonMetadata, v.Reason)
	v = g.Check(netip.MustParseAddr("::ffff:10.0.0.1"), nil)
	assert.Equal(t, netguard.ReasonRange, v.Reason)
	assert.Equal(t, "10.0.0.0/8", v.CIDR.String())
	assert.Equal(t, netguard.ReasonInvalid, g.Check(netip.Addr{}, nil).Reason)
}

func TestExplicitScopeOverridesBlock(t *testing.T) {
	ip := netip.MustParseAddr("10.0.0.5")
	assert.True(t, netguard.IsBlocked(ip, nil))
	assert.False(t, netguard.IsBlocked(ip, scopeIPs{netip.MustParsePrefix("10.0.0.0/24")}))
	assert.True(t, netguard.IsBlocked(ip, scopeIPs{netip.MustParsePrefix("10.1.0.0/24")}))
	// An IPv4-mapped form is matched against the IPv4 scope rule.
	assert.False(t, netguard.IsBlocked(netip.MustParseAddr("::ffff:10.0.0.5"), scopeIPs{netip.MustParsePrefix("10.0.0.5/32")}))
	// Metadata, loopback and link-local are never opened by scope (#880, §8.2).
	md := netip.MustParseAddr("169.254.169.254")
	assert.True(t, netguard.IsBlocked(md, scopeIPs{netip.MustParsePrefix("169.254.169.254/32")}))
}

// Loopback, link-local and the metadata service stay denied even when a scope rule names them.
func TestNeverInScopeIgnoresScope(t *testing.T) {
	for _, s := range []string{
		"127.0.0.1", "127.9.9.9", "::1", "169.254.169.254", "169.254.1.1", "fe80::1", "fd00:ec2::254",
		"::ffff:127.0.0.1", "64:ff9b::7f00:1",
	} {
		ip := netip.MustParseAddr(s)
		all := scopeIPs{netip.PrefixFrom(ip, ip.BitLen()), netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0")}
		v := netguard.Default().Check(ip, all)
		assert.True(t, v.Blocked, s)
		assert.True(t, netguard.IsBlocked(ip, all), s)
	}
	// The same rule still admits a private address that is not loopback, link-local or metadata.
	assert.False(t, netguard.IsBlocked(netip.MustParseAddr("10.9.9.9"), scopeIPs{netip.MustParsePrefix("10.0.0.0/8")}))
}

func TestNeverInScopePrefixes(t *testing.T) {
	for _, s := range []string{"127.0.0.0/8", "127.0.0.1/32", "0.0.0.0/0", "169.254.169.254/32", "169.254.0.0/16", "::1/128", "fe80::/10", "::/0"} {
		assert.True(t, netguard.NeverInScope(netip.MustParsePrefix(s)), s)
	}
	for _, s := range []string{"10.0.0.0/8", "172.30.250.0/24", "fd00::/64", "93.184.216.0/24"} {
		assert.False(t, netguard.NeverInScope(netip.MustParsePrefix(s)), s)
	}
}

func TestExtraBlocked(t *testing.T) {
	extra, err := netguard.ParseCIDRList("203.0.113.0/24, 198.51.100.7, ::ffff:192.0.2.0/120")
	require.NoError(t, err)
	g := netguard.New(extra)
	for _, s := range []string{"203.0.113.9", "198.51.100.7", "192.0.2.4", "10.0.0.1"} {
		assert.True(t, g.IsBlocked(netip.MustParseAddr(s), nil), s)
	}
	assert.Equal(t, netguard.ReasonExtra, g.Check(netip.MustParseAddr("203.0.113.9"), nil).Reason)
	assert.False(t, g.IsBlocked(netip.MustParseAddr("8.8.8.8"), nil))
	assert.False(t, netguard.IsBlocked(netip.MustParseAddr("203.0.113.9"), nil), "default guard is unchanged")
}

func TestParseCIDRList(t *testing.T) {
	p, err := netguard.ParseCIDRList("")
	require.NoError(t, err)
	assert.Empty(t, p)
	for _, bad := range []string{"10.0.0.1/33", "10.0.0.1/8", "x", "10.0.0.0/", "10.0.0.0/-1", "1.1.1.1,", "1.1.1.1/0x8"} {
		_, perr := netguard.ParseCIDRList(bad)
		assert.Error(t, perr, bad)
	}
	_, err = netguard.ParseCIDRList(string(make([]byte, 0)) + repeat("1.1.1.1,", 256) + "1.1.1.1")
	assert.Error(t, err, "too many entries")
}

func repeat(s string, n int) string {
	out := ""
	for range n {
		out += s
	}
	return out
}

func TestParseLiteral(t *testing.T) {
	ok := map[string]string{
		"127.0.0.1": "127.0.0.1", "0177.0.0.1": "127.0.0.1", "2130706433": "127.0.0.1",
		"0x7f000001": "127.0.0.1", "0x7f.1": "127.0.0.1", "127.1": "127.0.0.1",
		"017700000001": "127.0.0.1", "169.254.169.254.": "169.254.169.254",
		"::ffff:127.0.0.1": "127.0.0.1", "[::1]": "::1", "fe80::1%eth0": "fe80::1",
		"::ffff:7f00:1": "127.0.0.1", "0": "0.0.0.0",
	}
	for in, want := range ok {
		got, err := netguard.ParseLiteral(in)
		require.NoError(t, err, in)
		assert.Equal(t, want, got.String(), in)
	}
	for _, in := range []string{"example.com", "a.b.c.d", "app.example.test", "1password.com."} {
		_, err := netguard.ParseLiteral(in)
		assert.ErrorIs(t, err, netguard.ErrNotLiteral, in)
	}
	for _, in := range []string{
		"1.2.3.4.5", "256.1.1.1", "08.0.0.1", "0x.1", "1..2", "4294967296", "foo.1x", "+1.1.1.1",
		"fe80::1%", "fe80::1%a b", "fe80::1%eth0%eth1", "[1.2.3.4", "1.2.3.4]", ":::", "1.2.3.4:80",
		"::1%aaaaaaaaaaaaaaaa", "300.1",
	} {
		_, err := netguard.ParseLiteral(in)
		assert.ErrorIs(t, err, netguard.ErrInvalidLiteral, in)
	}
}

func TestLiteralFormsBlockWhenPrivate(t *testing.T) {
	for _, in := range []string{"0177.0.0.1", "2130706433", "0x7f.0.0.1", "::ffff:10.0.0.1", "0xa9fea9fe", "025177524776"} {
		ip, err := netguard.ParseLiteral(in)
		require.NoError(t, err, in)
		assert.True(t, netguard.IsBlocked(ip, nil), in)
	}
}

func TestDialControl(t *testing.T) {
	var got []netguard.Verdict
	ctl := netguard.Default().DialControl(scopeIPs{netip.MustParsePrefix("10.9.9.9/32")},
		func(_ netip.Addr, v netguard.Verdict) { got = append(got, v) })
	require.NoError(t, ctl("tcp", "93.184.216.34:443", nil))
	require.NoError(t, ctl("tcp", "10.9.9.9:80", nil), "explicitly in scope")
	for _, addr := range []string{"169.254.169.254:80", "127.0.0.1:8080", "[::1]:80", "[::ffff:10.0.0.1]:80", "[fe80::1%eth0]:80", "0.0.0.0:80"} {
		err := ctl("tcp", addr, nil)
		require.Error(t, err, addr)
		assert.True(t, errors.Is(err, netguard.ErrBlocked), addr)
	}
	err := ctl("tcp", "not-an-address", nil)
	assert.ErrorIs(t, err, netguard.ErrBlocked)
	assert.Len(t, got, 7)
}

// A real dialer wired with DialControl never connects to a blocked loopback listener.
func TestDialerDoesNotConnect(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = l.Close() }()
	accepted := make(chan struct{}, 1)
	go func() {
		if c, aerr := l.Accept(); aerr == nil {
			accepted <- struct{}{}
			_ = c.Close()
		}
	}()
	d := net.Dialer{Control: netguard.Default().DialControl(nil, nil)}
	_, err = d.Dial("tcp", l.Addr().String())
	require.ErrorIs(t, err, netguard.ErrBlocked)
	select {
	case <-accepted:
		t.Fatal("blocked dial reached the listener")
	default:
	}
}

// Property: every address inside a blocked CIDR is blocked without scope, and allowed when the
// exact address is in scope.
func TestPropertyBlockedCIDRs(t *testing.T) {
	x := uint64(0x9e3779b97f4a7c15)
	bit := func() bool { // xorshift64: deterministic, no weak-RNG use
		x ^= x << 13
		x ^= x >> 7
		x ^= x << 17
		return x&1 == 1
	}
	for _, p := range netguard.DefaultBlocked() {
		for range 200 {
			b := p.Addr().As16()
			if p.Addr().Is4() {
				b4 := p.Addr().As4()
				for i := p.Bits(); i < 32; i++ {
					if bit() {
						b4[i/8] |= 1 << (7 - i%8)
					} else {
						b4[i/8] &^= 1 << (7 - i%8)
					}
				}
				ip := netip.AddrFrom4(b4)
				require.True(t, netguard.IsBlocked(ip, nil), ip.String())
				require.True(t, netguard.IsBlocked(netip.AddrFrom16(ip.As16()), nil), "mapped "+ip.String())
				if !netguard.NeverInScope(p) {
					require.False(t, netguard.IsBlocked(ip, scopeIPs{netip.PrefixFrom(ip, 32)}))
				}
				continue
			}
			for i := p.Bits(); i < 128; i++ {
				if bit() {
					b[i/8] |= 1 << (7 - i%8)
				} else {
					b[i/8] &^= 1 << (7 - i%8)
				}
			}
			ip := netip.AddrFrom16(b)
			if netip.MustParsePrefix("64:ff9b::/96").Contains(ip) {
				continue
			}
			require.True(t, netguard.IsBlocked(ip, nil), ip.String())
			if !netguard.NeverInScope(p) {
				require.False(t, netguard.IsBlocked(ip, scopeIPs{netip.PrefixFrom(ip, 128)}), ip.String())
			}
		}
	}
}
