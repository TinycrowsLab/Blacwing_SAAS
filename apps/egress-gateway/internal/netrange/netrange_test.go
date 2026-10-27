package netrange_test

import (
	"net/netip"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/netrange"
)

func TestIsBlocked(t *testing.T) {
	for _, s := range []string{
		"10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "0.0.0.0",
		"169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "224.0.0.1",
		"255.255.255.255", "198.19.0.1", "192.0.0.8",
		"::", "::1", "fd00:ec2::254", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::a00:1",
		"::ffff:10.0.0.1", "::ffff:169.254.169.254", "fe80::1%eth0",
	} {
		assert.True(t, netrange.IsBlocked(netip.MustParseAddr(s)), s)
	}
	for _, s := range []string{
		"93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1",
		"2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8",
	} {
		assert.False(t, netrange.IsBlocked(netip.MustParseAddr(s)), s)
	}
	assert.True(t, netrange.IsBlocked(netip.Addr{}), "invalid address fails closed")
}
