package config_test

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/config"
)

// sentinel is a value that must never appear in any error or log output.
const sentinel = "s3cr3t-sentinel-value-0xDEADBEEF"

// required holds valid values for the required non-enum keys; load adds them unless
// the test sets (or deletes, with the value "<unset>") the key itself.
var required = map[string]string{
	"POLICY_SNAPSHOT_PATH": "/var/run/blackwing/policy.snapshot",
	"VALKEY_URL":           "redis://localhost:16379/0",
}

const unset = "<unset>"

func withRequired(env map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range required {
		out[k] = v
	}
	for k, v := range env {
		if v == unset {
			delete(out, k)
			continue
		}
		out[k] = v
	}
	return out
}

func load(t *testing.T, env map[string]string) (*config.Config, *config.ValidationError) {
	t.Helper()
	cfg, err := config.Load(config.MapLookup(withRequired(env)))
	if err == nil {
		require.NotNil(t, cfg)
		return cfg, nil
	}
	require.Nil(t, cfg, "a failed load must never return a partial config")
	var verr *config.ValidationError
	require.ErrorAs(t, err, &verr)
	return nil, verr
}

func TestLoadValidMinimal(t *testing.T) {
	cfg, verr := load(t, map[string]string{"BW_ENV": "dev"})
	require.Nil(t, verr)
	assert.Equal(t, config.EnvDev, cfg.Env)
	assert.Equal(t, slog.LevelInfo, cfg.LogLevel, "LOG_LEVEL defaults to info when absent")
}

func TestLoadAcceptsEveryEnvironment(t *testing.T) {
	for _, env := range []config.Environment{config.EnvDev, config.EnvTest, config.EnvStaging, config.EnvProduction} {
		t.Run(string(env), func(t *testing.T) {
			cfg, verr := load(t, map[string]string{"BW_ENV": string(env)})
			require.Nil(t, verr)
			assert.Equal(t, env, cfg.Env)
		})
	}
}

func TestLoadAcceptsEveryLogLevel(t *testing.T) {
	cases := map[string]slog.Level{
		"debug": slog.LevelDebug,
		"info":  slog.LevelInfo,
		"warn":  slog.LevelWarn,
		"error": slog.LevelError,
	}
	for raw, want := range cases {
		t.Run(raw, func(t *testing.T) {
			cfg, verr := load(t, map[string]string{"BW_ENV": "test", "LOG_LEVEL": raw})
			require.Nil(t, verr)
			assert.Equal(t, want, cfg.LogLevel)
		})
	}
}

// Fail closed: with an empty environment nothing is assumed and loading fails.
func TestLoadFailsClosedOnEmptyEnvironment(t *testing.T) {
	_, verr := load(t, map[string]string{})
	require.NotNil(t, verr)
	assert.Equal(t, []string{"BW_ENV"}, verr.Keys())
	assert.Contains(t, verr.Error(), "BW_ENV: is required")
}

func TestLoadRejectsEmptyRequiredValue(t *testing.T) {
	for _, raw := range []string{"", "   ", "\t\n"} {
		_, verr := load(t, map[string]string{"BW_ENV": raw})
		require.NotNil(t, verr, "BW_ENV=%q must be rejected", raw)
		assert.Equal(t, []string{"BW_ENV"}, verr.Keys())
		assert.Contains(t, verr.Error(), "must not be empty")
	}
}

func TestLoadRejectsEmptyOptionalValueInsteadOfDefaulting(t *testing.T) {
	_, verr := load(t, map[string]string{"BW_ENV": "dev", "LOG_LEVEL": ""})
	require.NotNil(t, verr)
	assert.Equal(t, []string{"LOG_LEVEL"}, verr.Keys())
	assert.Contains(t, verr.Error(), "must not be empty when set")
}

func TestLoadRejectsUnknownValues(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		key  string
	}{
		{"unknown env", map[string]string{"BW_ENV": "prod"}, "BW_ENV"},
		{"env is case sensitive", map[string]string{"BW_ENV": "DEV"}, "BW_ENV"},
		{"node-style env name", map[string]string{"BW_ENV": "development"}, "BW_ENV"},
		{"unknown level", map[string]string{"BW_ENV": "dev", "LOG_LEVEL": "trace"}, "LOG_LEVEL"},
		{"numeric level", map[string]string{"BW_ENV": "dev", "LOG_LEVEL": "4"}, "LOG_LEVEL"},
		{"level is case sensitive", map[string]string{"BW_ENV": "dev", "LOG_LEVEL": "INFO"}, "LOG_LEVEL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, verr := load(t, tc.env)
			require.NotNil(t, verr)
			assert.Equal(t, []string{tc.key}, verr.Keys())
			assert.Contains(t, verr.Error(), "must be one of")
		})
	}
}

func TestLoadTrimsDeclaredEnumKeys(t *testing.T) {
	cfg, verr := load(t, map[string]string{"BW_ENV": "  staging\n", "LOG_LEVEL": " warn "})
	require.Nil(t, verr)
	assert.Equal(t, config.EnvStaging, cfg.Env)
	assert.Equal(t, slog.LevelWarn, cfg.LogLevel)
}

func TestLoadReportsAllProblemsAtOnce(t *testing.T) {
	_, verr := load(t, map[string]string{"LOG_LEVEL": "verbose"})
	require.NotNil(t, verr)
	assert.Equal(t, []string{"BW_ENV", "LOG_LEVEL"}, verr.Keys())
	assert.Contains(t, verr.Error(), "2 problem(s)")
}

// No secrets logged: an invalid value must never be echoed by the error, by its
// structured-log rendering, or by any fmt verb.
func TestValidationErrorNeverLeaksValues(t *testing.T) {
	_, verr := load(t, map[string]string{"BW_ENV": sentinel, "LOG_LEVEL": sentinel})
	require.NotNil(t, verr)

	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	logger.Error("config invalid", slog.Any("issues", verr), slog.Any("err", error(verr)))

	outputs := []string{
		verr.Error(),
		fmt.Sprintf("%v", verr),
		fmt.Sprintf("%+v", verr),
		fmt.Sprintf("%#v", verr.Issues),
		buf.String(),
	}
	for _, out := range outputs {
		assert.NotContains(t, out, sentinel)
	}
	assert.Contains(t, buf.String(), `"BW_ENV":"must be one of dev|test|staging|production"`)
}

func TestLoadRejectsNilLookup(t *testing.T) {
	cfg, err := config.Load(nil)
	require.Error(t, err)
	assert.Nil(t, cfg)
	var verr *config.ValidationError
	assert.False(t, errors.As(err, &verr))
}

func TestFromEnvironReadsProcessEnvironment(t *testing.T) {
	t.Setenv("BW_ENV", "test")
	t.Setenv("LOG_LEVEL", "debug")
	for k, v := range required {
		t.Setenv(k, v)
	}
	cfg, err := config.FromEnviron()
	require.NoError(t, err)
	assert.Equal(t, config.EnvTest, cfg.Env)
	assert.Equal(t, slog.LevelDebug, cfg.LogLevel)
}

func TestConfigLogValueListsFieldsExplicitly(t *testing.T) {
	cfg, verr := load(t, map[string]string{"BW_ENV": "production", "LOG_LEVEL": "error"})
	require.Nil(t, verr)

	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("config loaded", slog.Any("config", *cfg))
	assert.Contains(t, buf.String(), `"config":{"env":"production","log_level":"error",`+
		`"mgmt_addr":":9090","http_proxy_addr":":3128","socks_addr":":1080","dns_addr":":5353",`+
		`"dns_upstream":"","dns_pin_ttl":"2m0s","dns_strict_cname":true,`+
		`"extra_blocked_cidrs":0,"validate_redirect_target":true,`+
		`"policy_snapshot_path":"/var/run/blackwing/policy.snapshot","valkey_url":"[REDACTED]",`+
		`"otlp_export":false,"drain_timeout":"10s"}`)
}

func TestKeysAreSortedAndComplete(t *testing.T) {
	keys := config.Keys()
	assert.Equal(t, []string{
		"BW_ENV", "GATEWAY_DNS_ADDR", "GATEWAY_DNS_PIN_TTL", "GATEWAY_DNS_STRICT_CNAME",
		"GATEWAY_DNS_UPSTREAM", "GATEWAY_DRAIN_TIMEOUT", "GATEWAY_EXTRA_BLOCKED_CIDRS",
		"GATEWAY_HTTP_PROXY_ADDR", "GATEWAY_MGMT_ADDR", "GATEWAY_SOCKS_ADDR",
		"GATEWAY_VALIDATE_REDIRECT_TARGET", "LOG_LEVEL", "OTEL_EXPORTER_OTLP_ENDPOINT",
		"POLICY_SNAPSHOT_PATH", "VALKEY_URL",
	}, keys)
	for i := 1; i < len(keys); i++ {
		assert.True(t, strings.Compare(keys[i-1], keys[i]) < 0)
	}
}
