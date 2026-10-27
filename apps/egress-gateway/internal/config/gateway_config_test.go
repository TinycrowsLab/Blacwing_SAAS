package config_test

import (
	"bytes"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadAppliesListenerAndDrainDefaults(t *testing.T) {
	cfg, verr := load(t, map[string]string{"BW_ENV": "dev"})
	require.Nil(t, verr)
	assert.Equal(t, ":9090", cfg.MgmtAddr)
	assert.Equal(t, ":3128", cfg.HTTPProxyAddr)
	assert.Equal(t, ":1080", cfg.SOCKSAddr)
	assert.Equal(t, ":5353", cfg.DNSAddr)
	assert.Equal(t, 10*time.Second, cfg.DrainTimeout)
	assert.Empty(t, cfg.OTLPEndpoint, "OTLP export is off unless configured")
	assert.Equal(t, "/var/run/blackwing/policy.snapshot", cfg.PolicySnapshotPath)
	assert.Equal(t, "redis://localhost:16379/0", cfg.ValkeyURL.Reveal())
}

func TestLoadAcceptsExplicitValues(t *testing.T) {
	cfg, verr := load(t, map[string]string{
		"BW_ENV":                      "dev",
		"GATEWAY_MGMT_ADDR":           "127.0.0.1:13129",
		"GATEWAY_HTTP_PROXY_ADDR":     "10.0.0.5:13128",
		"GATEWAY_SOCKS_ADDR":          "[::1]:11080",
		"GATEWAY_DNS_ADDR":            "egress.internal:15353",
		"OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:14318",
		"GATEWAY_DRAIN_TIMEOUT":       "250ms",
		"VALKEY_URL":                  "rediss://:pw@valkey:6380/1",
	})
	require.Nil(t, verr)
	assert.Equal(t, "127.0.0.1:13129", cfg.MgmtAddr)
	assert.Equal(t, "[::1]:11080", cfg.SOCKSAddr)
	assert.Equal(t, "egress.internal:15353", cfg.DNSAddr)
	assert.Equal(t, "http://localhost:14318", cfg.OTLPEndpoint)
	assert.Equal(t, 250*time.Millisecond, cfg.DrainTimeout)
}

// Edge case: missing/empty required config -> load fails (the CLI exits non-zero
// before any listener is bound).
func TestLoadRejectsMissingOrEmptyRequiredGatewayKeys(t *testing.T) {
	for _, key := range []string{"POLICY_SNAPSHOT_PATH", "VALKEY_URL"} {
		t.Run(key+"/missing", func(t *testing.T) {
			_, verr := load(t, map[string]string{"BW_ENV": "dev", key: unset})
			require.NotNil(t, verr)
			assert.Equal(t, []string{key}, verr.Keys())
			assert.Equal(t, "is required", verr.Issues[0].Reason)
		})
		t.Run(key+"/empty", func(t *testing.T) {
			_, verr := load(t, map[string]string{"BW_ENV": "dev", key: "  "})
			require.NotNil(t, verr)
			assert.Equal(t, []string{key}, verr.Keys())
			assert.Equal(t, "must not be empty", verr.Issues[0].Reason)
		})
	}
}

// Acceptance: invalid config (bad addr) is a clear, keyed error.
func TestLoadRejectsBadListenAddresses(t *testing.T) {
	cases := map[string]string{
		"no port":         "localhost",
		"port zero":       ":0",
		"port too big":    ":65536",
		"named port":      ":http",
		"empty when set":  "",
		"bad host":        "bad_host!:9090",
		"garbage":         "::::",
		"trailing colons": "host:9090:1",
	}
	for _, key := range []string{"GATEWAY_MGMT_ADDR", "GATEWAY_HTTP_PROXY_ADDR", "GATEWAY_SOCKS_ADDR", "GATEWAY_DNS_ADDR"} {
		for name, value := range cases {
			t.Run(key+"/"+name, func(t *testing.T) {
				_, verr := load(t, map[string]string{"BW_ENV": "dev", key: value})
				require.NotNil(t, verr)
				assert.Contains(t, verr.Keys(), key)
			})
		}
	}
}

func TestLoadRejectsListenerCollisions(t *testing.T) {
	cases := []map[string]string{
		{"GATEWAY_MGMT_ADDR": ":3128"},
		{"GATEWAY_MGMT_ADDR": "127.0.0.1:1080"},
		{"GATEWAY_DNS_ADDR": "10.0.0.1:9090", "GATEWAY_MGMT_ADDR": "10.0.0.1:9090"},
	}
	for i, extra := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			env := map[string]string{"BW_ENV": "dev"}
			for k, v := range extra {
				env[k] = v
			}
			_, verr := load(t, env)
			require.NotNil(t, verr)
			assert.Contains(t, verr.Error(), "conflicts with")
		})
	}
	// Same port on two distinct specific hosts is fine.
	_, verr := load(t, map[string]string{
		"BW_ENV": "dev", "GATEWAY_MGMT_ADDR": "127.0.0.1:3128", "GATEWAY_HTTP_PROXY_ADDR": "10.0.0.5:3128",
	})
	assert.Nil(t, verr)
}

func TestLoadRejectsBadValkeyURLWithoutLeakingIt(t *testing.T) {
	cases := map[string]string{
		"scheme":  "http://" + sentinel + "@valkey:6379",
		"no host": "redis://" + sentinel + "@/0",
		"parse":   "redis://%zz" + sentinel,
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			_, verr := load(t, map[string]string{"BW_ENV": "dev", "VALKEY_URL": value})
			require.NotNil(t, verr)
			assert.Equal(t, []string{"VALKEY_URL"}, verr.Keys())
			assert.NotContains(t, verr.Error(), sentinel)
		})
	}
}

func TestLoadRejectsBadOTLPEndpoint(t *testing.T) {
	for name, value := range map[string]string{
		"empty":       "",
		"relative":    "localhost:4318",
		"grpc scheme": "grpc://collector:4317",
		"credentials": "https://user:" + sentinel + "@collector:4318",
	} {
		t.Run(name, func(t *testing.T) {
			_, verr := load(t, map[string]string{"BW_ENV": "dev", "OTEL_EXPORTER_OTLP_ENDPOINT": value})
			require.NotNil(t, verr)
			assert.Equal(t, []string{"OTEL_EXPORTER_OTLP_ENDPOINT"}, verr.Keys())
			assert.NotContains(t, verr.Error(), sentinel)
		})
	}
}

func TestLoadRejectsBadDrainTimeout(t *testing.T) {
	for _, value := range []string{"", "10", "-1s", "0s", "6m", "soon"} {
		t.Run(value, func(t *testing.T) {
			_, verr := load(t, map[string]string{"BW_ENV": "dev", "GATEWAY_DRAIN_TIMEOUT": value})
			require.NotNil(t, verr)
			assert.Equal(t, []string{"GATEWAY_DRAIN_TIMEOUT"}, verr.Keys())
		})
	}
}

func TestValkeyURLNeverLogged(t *testing.T) {
	cfg, verr := load(t, map[string]string{"BW_ENV": "dev", "VALKEY_URL": "redis://:" + sentinel + "@valkey:6379"})
	require.Nil(t, verr)
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("cfg", slog.Any("config", *cfg))
	assert.NotContains(t, buf.String(), sentinel)
	assert.NotContains(t, fmt.Sprintf("%v %+v %#v", cfg, *cfg, *cfg), sentinel)
}

func TestHashIsStableCoversValuesButNotSecrets(t *testing.T) {
	a, _ := load(t, map[string]string{"BW_ENV": "dev"})
	b, _ := load(t, map[string]string{"BW_ENV": "dev"})
	require.NotNil(t, a)
	require.NotNil(t, b)
	assert.Equal(t, a.Hash(), b.Hash())
	assert.Len(t, a.Hash(), 64)

	c, _ := load(t, map[string]string{"BW_ENV": "dev", "GATEWAY_DRAIN_TIMEOUT": "5s"})
	require.NotNil(t, c)
	assert.NotEqual(t, a.Hash(), c.Hash(), "a non-secret change alters the hash")

	d, _ := load(t, map[string]string{"BW_ENV": "dev", "VALKEY_URL": "redis://:other@localhost:16379/0"})
	require.NotNil(t, d)
	assert.Equal(t, a.Hash(), d.Hash(), "secret values must not influence the hash")
	assert.NotContains(t, d.Hash(), "other")
}

func TestLoadAppliesDNSDefaultsAndExplicitValues(t *testing.T) {
	cfg, verr := load(t, map[string]string{"BW_ENV": "dev"})
	require.Nil(t, verr)
	assert.Empty(t, cfg.DNSUpstream, "empty means the system resolver")
	assert.Equal(t, 120*time.Second, cfg.DNSPinTTL)
	assert.True(t, cfg.DNSStrictCNAME, "strict CNAME checking is on by default")

	cfg, verr = load(t, map[string]string{
		"BW_ENV": "dev", "GATEWAY_DNS_UPSTREAM": "10.0.0.2:53",
		"GATEWAY_DNS_PIN_TTL": "30s", "GATEWAY_DNS_STRICT_CNAME": "false",
	})
	require.Nil(t, verr)
	assert.Equal(t, "10.0.0.2:53", cfg.DNSUpstream)
	assert.Equal(t, 30*time.Second, cfg.DNSPinTTL)
	assert.False(t, cfg.DNSStrictCNAME)
}

func TestLoadRejectsBadDNSSettings(t *testing.T) {
	cases := map[string][]string{
		"GATEWAY_DNS_UPSTREAM":     {"", "8.8.8.8", ":53", "8.8.8.8:0"},
		"GATEWAY_DNS_PIN_TTL":      {"", "120", "0s", "-1s", "2h", "soon"},
		"GATEWAY_DNS_STRICT_CNAME": {"", "yes", "1", "FALSE"},
	}
	for key, values := range cases {
		for _, value := range values {
			t.Run(key+"="+value, func(t *testing.T) {
				_, verr := load(t, map[string]string{"BW_ENV": "dev", key: value})
				require.NotNil(t, verr)
				assert.Equal(t, []string{key}, verr.Keys())
			})
		}
	}
}

func TestLoadNetguardSettings(t *testing.T) {
	cfg, verr := load(t, map[string]string{"BW_ENV": "dev"})
	require.Nil(t, verr)
	assert.Empty(t, cfg.ExtraBlockedCIDRs)
	assert.True(t, cfg.ValidateRedirectTarget, "redirect validation is on by default")

	cfg, verr = load(t, map[string]string{
		"BW_ENV": "dev", "GATEWAY_EXTRA_BLOCKED_CIDRS": "203.0.113.0/24,198.51.100.7",
		"GATEWAY_VALIDATE_REDIRECT_TARGET": "false",
	})
	require.Nil(t, verr)
	assert.Len(t, cfg.ExtraBlockedCIDRs, 2)
	assert.False(t, cfg.ValidateRedirectTarget)

	for key, bad := range map[string]string{
		"GATEWAY_EXTRA_BLOCKED_CIDRS":      "10.0.0.1/8",
		"GATEWAY_VALIDATE_REDIRECT_TARGET": "yes",
	} {
		_, verr = load(t, map[string]string{"BW_ENV": "dev", key: bad})
		require.NotNil(t, verr, key)
	}
}

func TestLoadAppliesHTTPProxyListenerDefaults(t *testing.T) {
	cfg, verr := load(t, map[string]string{"BW_ENV": "dev"})
	require.Nil(t, verr)
	assert.Equal(t, 30*time.Second, cfg.ReadTimeout)
	assert.Equal(t, 60*time.Second, cfg.WriteTimeout)
	assert.Equal(t, 90*time.Second, cfg.IdleTimeout)
	assert.Equal(t, 64<<10, cfg.MaxHeaderBytes)
	assert.True(t, cfg.MITMEnabled)
}

func TestLoadAcceptsExplicitHTTPProxyListenerValues(t *testing.T) {
	cfg, verr := load(t, map[string]string{
		"BW_ENV":                   "dev",
		"GATEWAY_READ_TIMEOUT":     "5s",
		"GATEWAY_WRITE_TIMEOUT":    "6s",
		"GATEWAY_IDLE_TIMEOUT":     "7s",
		"GATEWAY_MAX_HEADER_BYTES": "4096",
		"GATEWAY_MITM_ENABLED":     "false",
	})
	require.Nil(t, verr)
	assert.Equal(t, 5*time.Second, cfg.ReadTimeout)
	assert.Equal(t, 6*time.Second, cfg.WriteTimeout)
	assert.Equal(t, 7*time.Second, cfg.IdleTimeout)
	assert.Equal(t, 4096, cfg.MaxHeaderBytes)
	assert.False(t, cfg.MITMEnabled)
}

func TestLoadRejectsInvalidHTTPProxyListenerValues(t *testing.T) {
	for key, bad := range map[string][]string{
		"GATEWAY_READ_TIMEOUT":     {"", "abc", "0s", "-1s", "6m"},
		"GATEWAY_WRITE_TIMEOUT":    {"", "abc", "0s", "6m"},
		"GATEWAY_IDLE_TIMEOUT":     {"", "abc", "0s", "6m"},
		"GATEWAY_MAX_HEADER_BYTES": {"", "abc", "1023", "1048577", "-5"},
		"GATEWAY_MITM_ENABLED":     {"", "yes", "1", "TRUE"},
	} {
		for _, v := range bad {
			t.Run(fmt.Sprintf("%s=%q", key, v), func(t *testing.T) {
				_, verr := load(t, map[string]string{"BW_ENV": "dev", key: v})
				require.NotNil(t, verr)
				assert.Equal(t, []string{key}, verr.Keys())
			})
		}
	}
}
