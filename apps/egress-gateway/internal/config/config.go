// Package config loads and validates the egress gateway's configuration from the
// process environment.
//
// It mirrors the philosophy of the TypeScript @blackwing/config package:
//
//   - the environment is read exactly once, at startup, through Load;
//   - every key is validated and all problems are reported together, not first-fail;
//   - any missing or invalid value is an error, and the caller must refuse to start
//     (fail closed, CONTEXT_PACK §8.2); there is no "best effort" mode;
//   - no default weakens security, and required keys have no default at all;
//   - error messages and log output carry key names and reasons only, never values,
//     so a misconfigured secret can never leak through an error (CONTEXT_PACK §8.7).
//
// Later EGRESS issues extend Config with their own keys by adding fields and a
// matching parse step in Load. Keys that carry credentials must be stored as Secret.
package config

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Environment keys read by Load.
const (
	// KeyEnv selects the deployment environment. Required, no default.
	KeyEnv = "BW_ENV"
	// KeyLogLevel sets the minimum log level. Optional, defaults to "info".
	KeyLogLevel = "LOG_LEVEL"
	// KeyMgmtAddr is the management-plane listen address (health, metrics, control
	// API). Optional, defaults to ":9090". In deployment it must be an internal
	// interface, never the sandbox-facing one.
	KeyMgmtAddr = "GATEWAY_MGMT_ADDR"
	// KeyHTTPProxyAddr is the HTTP(S) proxy data-plane listen address. Optional,
	// defaults to ":3128".
	KeyHTTPProxyAddr = "GATEWAY_HTTP_PROXY_ADDR"
	// KeySOCKSAddr is the SOCKS5 data-plane listen address. Optional, defaults to ":1080".
	KeySOCKSAddr = "GATEWAY_SOCKS_ADDR"
	// KeyDNSAddr is the scoped DNS data-plane listen address. Optional, defaults to ":5353".
	KeyDNSAddr = "GATEWAY_DNS_ADDR"
	// KeyDNSUpstream is the host:port of the upstream DNS server the scoped resolver
	// queries. Optional; empty uses the system resolver.
	KeyDNSUpstream = "GATEWAY_DNS_UPSTREAM"
	// KeyDNSPinTTL is how long a resolved IP stays pinned (anti-rebinding). Optional,
	// defaults to 120s; must be within (0, 1h].
	KeyDNSPinTTL = "GATEWAY_DNS_PIN_TTL"
	// KeyDNSStrictCNAME requires every name in a CNAME chain to be in scope. Optional,
	// defaults to true; accepts only "true" or "false".
	KeyDNSStrictCNAME = "GATEWAY_DNS_STRICT_CNAME"
	// KeyPolicySnapshotPath is the file path of the signed policy snapshot. Required.
	KeyPolicySnapshotPath = "POLICY_SNAPSHOT_PATH"
	// KeyValkeyURL is the Valkey connection URL (redis://, rediss://, valkey://,
	// valkeys://). Required. Stored as a Secret because it may carry credentials.
	KeyValkeyURL = "VALKEY_URL"
	// KeyOTLPEndpoint is the OpenTelemetry OTLP/HTTP collector endpoint. Optional;
	// when unset, spans are recorded but not exported.
	KeyOTLPEndpoint = "OTEL_EXPORTER_OTLP_ENDPOINT"
	// KeyDrainTimeout bounds the graceful drain on SIGTERM/SIGINT. Optional,
	// defaults to 10s; must be within (0, 5m].
	KeyDrainTimeout = "GATEWAY_DRAIN_TIMEOUT"
)

// Defaults for the optional keys.
const (
	DefaultMgmtAddr      = ":9090"
	DefaultHTTPProxyAddr = ":3128"
	DefaultSOCKSAddr     = ":1080"
	DefaultDNSAddr       = ":5353"
	DefaultDrainTimeout  = 10 * time.Second
	DefaultDNSPinTTL     = 120 * time.Second
	maxDrainTimeout      = 5 * time.Minute
	maxDNSPinTTL         = time.Hour
)

// Environment is the deployment environment the gateway runs in.
type Environment string

// Supported environments. The set matches the BW_ENV values used across the
// Blackwing services; anything else is rejected.
const (
	EnvDev        Environment = "dev"
	EnvTest       Environment = "test"
	EnvStaging    Environment = "staging"
	EnvProduction Environment = "production"
)

var environments = []Environment{EnvDev, EnvTest, EnvStaging, EnvProduction}

// logLevels maps the accepted LOG_LEVEL values to slog levels.
var logLevels = map[string]slog.Level{
	"debug": slog.LevelDebug,
	"info":  slog.LevelInfo,
	"warn":  slog.LevelWarn,
	"error": slog.LevelError,
}

// defaultLogLevel is used only when LOG_LEVEL is absent from the environment.
const defaultLogLevel = slog.LevelInfo

// Config is the validated gateway configuration. A Config value is only ever
// produced by Load, so holding one means every field passed validation.
type Config struct {
	// Env is the deployment environment (BW_ENV).
	Env Environment
	// LogLevel is the minimum level emitted by the structured logger (LOG_LEVEL).
	LogLevel slog.Level
	// MgmtAddr is the management-plane listen address (GATEWAY_MGMT_ADDR).
	MgmtAddr string
	// HTTPProxyAddr is the HTTP(S) proxy listen address (GATEWAY_HTTP_PROXY_ADDR).
	HTTPProxyAddr string
	// SOCKSAddr is the SOCKS5 listen address (GATEWAY_SOCKS_ADDR).
	SOCKSAddr string
	// DNSAddr is the scoped DNS listen address (GATEWAY_DNS_ADDR).
	DNSAddr string
	// DNSUpstream is the upstream DNS server (GATEWAY_DNS_UPSTREAM); empty means system.
	DNSUpstream string
	// DNSPinTTL is the resolved-IP pin lifetime (GATEWAY_DNS_PIN_TTL).
	DNSPinTTL time.Duration
	// DNSStrictCNAME requires CNAME chains to stay in scope (GATEWAY_DNS_STRICT_CNAME).
	DNSStrictCNAME bool
	// PolicySnapshotPath is the signed policy snapshot file (POLICY_SNAPSHOT_PATH).
	PolicySnapshotPath string
	// ValkeyURL is the Valkey connection URL (VALKEY_URL); it may carry credentials.
	ValkeyURL Secret
	// OTLPEndpoint is the OTLP/HTTP collector endpoint (OTEL_EXPORTER_OTLP_ENDPOINT);
	// empty disables export.
	OTLPEndpoint string
	// DrainTimeout bounds the graceful drain on shutdown (GATEWAY_DRAIN_TIMEOUT).
	DrainTimeout time.Duration
}

// Keys returns the environment keys the loader understands, sorted. It is used to
// log which keys were resolved without logging their values.
func Keys() []string {
	keys := []string{
		KeyEnv, KeyLogLevel, KeyMgmtAddr, KeyHTTPProxyAddr, KeySOCKSAddr, KeyDNSAddr,
		KeyDNSUpstream, KeyDNSPinTTL, KeyDNSStrictCNAME,
		KeyPolicySnapshotPath, KeyValkeyURL, KeyOTLPEndpoint, KeyDrainTimeout,
	}
	sort.Strings(keys)
	return keys
}

// LogValue renders the configuration for structured logs. Every field is listed
// explicitly so that a field added later (for example a Secret) is never dumped by
// reflection; Secret fields render through Secret.LogValue.
func (c Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("env", string(c.Env)),
		slog.String("log_level", strings.ToLower(c.LogLevel.String())),
		slog.String("mgmt_addr", c.MgmtAddr),
		slog.String("http_proxy_addr", c.HTTPProxyAddr),
		slog.String("socks_addr", c.SOCKSAddr),
		slog.String("dns_addr", c.DNSAddr),
		slog.String("dns_upstream", c.DNSUpstream),
		slog.String("dns_pin_ttl", c.DNSPinTTL.String()),
		slog.Bool("dns_strict_cname", c.DNSStrictCNAME),
		slog.String("policy_snapshot_path", c.PolicySnapshotPath),
		slog.Any("valkey_url", c.ValkeyURL),
		slog.Bool("otlp_export", c.OTLPEndpoint != ""),
		slog.String("drain_timeout", c.DrainTimeout.String()),
	)
}

// Hash returns a stable SHA-256 fingerprint of the configuration for audit events
// (gateway.started / gateway.stopped). It covers every non-secret value; secret
// fields contribute only whether they are set, so the hash can never be used to
// confirm a guessed credential.
func (c Config) Hash() string {
	fields := []string{
		KeyEnv + "=" + string(c.Env),
		KeyLogLevel + "=" + strings.ToLower(c.LogLevel.String()),
		KeyMgmtAddr + "=" + c.MgmtAddr,
		KeyHTTPProxyAddr + "=" + c.HTTPProxyAddr,
		KeySOCKSAddr + "=" + c.SOCKSAddr,
		KeyDNSAddr + "=" + c.DNSAddr,
		KeyDNSUpstream + "=" + c.DNSUpstream,
		KeyDNSPinTTL + "=" + c.DNSPinTTL.String(),
		KeyDNSStrictCNAME + "=" + strconv.FormatBool(c.DNSStrictCNAME),
		KeyPolicySnapshotPath + "=" + c.PolicySnapshotPath,
		KeyValkeyURL + "=set:" + strconv.FormatBool(!c.ValkeyURL.IsZero()),
		KeyOTLPEndpoint + "=" + c.OTLPEndpoint,
		KeyDrainTimeout + "=" + c.DrainTimeout.String(),
	}
	sum := sha256.Sum256([]byte(strings.Join(fields, "\n")))
	return hex.EncodeToString(sum[:])
}

// LookupFunc reports the value of an environment key and whether it is set. It has
// the signature of os.LookupEnv so tests can supply a fixed map instead.
type LookupFunc func(key string) (string, bool)

// MapLookup returns a LookupFunc backed by a fixed map, for tests and tooling.
func MapLookup(m map[string]string) LookupFunc {
	return func(key string) (string, bool) {
		v, ok := m[key]
		return v, ok
	}
}

// Issue describes one invalid or missing key. It never contains the offending value.
type Issue struct {
	Key    string
	Reason string
}

// ValidationError aggregates every configuration problem found by Load.
type ValidationError struct {
	Issues []Issue
}

// Error lists every failing key with its reason. Values are never included.
func (e *ValidationError) Error() string {
	parts := make([]string, 0, len(e.Issues))
	for _, is := range e.Issues {
		parts = append(parts, is.Key+": "+is.Reason)
	}
	return fmt.Sprintf("invalid egress-gateway configuration (%d problem(s)): %s",
		len(e.Issues), strings.Join(parts, "; "))
}

// LogValue renders the issues for structured logs (keys and reasons only).
func (e *ValidationError) LogValue() slog.Value {
	attrs := make([]slog.Attr, 0, len(e.Issues))
	for _, is := range e.Issues {
		attrs = append(attrs, slog.String(is.Key, is.Reason))
	}
	return slog.GroupValue(attrs...)
}

// Keys returns the failing keys in the order they were reported.
func (e *ValidationError) Keys() []string {
	keys := make([]string, 0, len(e.Issues))
	for _, is := range e.Issues {
		keys = append(keys, is.Key)
	}
	return keys
}

// FromEnviron loads the configuration from the real process environment.
func FromEnviron() (*Config, error) {
	return Load(os.LookupEnv)
}

// Load reads and validates every key through lookup. It returns either a fully
// valid Config or a *ValidationError listing every problem; it never returns a
// partially populated Config.
func Load(lookup LookupFunc) (*Config, error) {
	if lookup == nil {
		return nil, errors.New("config: nil LookupFunc")
	}

	var issues []Issue
	add := func(key, reason string) {
		issues = append(issues, Issue{Key: key, Reason: reason})
	}
	cfg := Config{}

	if env, reason := parseEnvironment(lookup); reason != "" {
		add(KeyEnv, reason)
	} else {
		cfg.Env = env
	}

	if level, reason := parseLogLevel(lookup); reason != "" {
		add(KeyLogLevel, reason)
	} else {
		cfg.LogLevel = level
	}

	listeners := []struct {
		key, def string
		dst      *string
	}{
		{KeyMgmtAddr, DefaultMgmtAddr, &cfg.MgmtAddr},
		{KeyHTTPProxyAddr, DefaultHTTPProxyAddr, &cfg.HTTPProxyAddr},
		{KeySOCKSAddr, DefaultSOCKSAddr, &cfg.SOCKSAddr},
		{KeyDNSAddr, DefaultDNSAddr, &cfg.DNSAddr},
	}
	for _, l := range listeners {
		if v, reason := parseAddr(lookup, l.key, l.def); reason != "" {
			add(l.key, reason)
		} else {
			*l.dst = v
		}
	}
	issues = append(issues, checkAddrCollisions(cfg)...)

	if u, reason := parseDNSUpstream(lookup); reason != "" {
		add(KeyDNSUpstream, reason)
	} else {
		cfg.DNSUpstream = u
	}
	if d, reason := parseDNSPinTTL(lookup); reason != "" {
		add(KeyDNSPinTTL, reason)
	} else {
		cfg.DNSPinTTL = d
	}
	if b, reason := parseStrictCNAME(lookup); reason != "" {
		add(KeyDNSStrictCNAME, reason)
	} else {
		cfg.DNSStrictCNAME = b
	}

	if p, reason := parseRequired(lookup, KeyPolicySnapshotPath); reason != "" {
		add(KeyPolicySnapshotPath, reason)
	} else {
		cfg.PolicySnapshotPath = p
	}

	if u, reason := parseValkeyURL(lookup); reason != "" {
		add(KeyValkeyURL, reason)
	} else {
		cfg.ValkeyURL = u
	}

	if e, reason := parseOTLPEndpoint(lookup); reason != "" {
		add(KeyOTLPEndpoint, reason)
	} else {
		cfg.OTLPEndpoint = e
	}

	if d, reason := parseDrainTimeout(lookup); reason != "" {
		add(KeyDrainTimeout, reason)
	} else {
		cfg.DrainTimeout = d
	}

	if len(issues) > 0 {
		return nil, &ValidationError{Issues: issues}
	}
	return &cfg, nil
}

// parseEnvironment validates BW_ENV: required, no default, one of environments.
// Surrounding whitespace is tolerated (declared trimming) because the value is an
// enum, never a secret.
func parseEnvironment(lookup LookupFunc) (Environment, string) {
	raw, ok := lookup(KeyEnv)
	if !ok {
		return "", "is required"
	}
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", "must not be empty"
	}
	for _, e := range environments {
		if v == string(e) {
			return e, ""
		}
	}
	return "", "must be one of " + joinEnvironments()
}

// parseLogLevel validates LOG_LEVEL. An absent key yields the default; a key that is
// present but empty is rejected rather than silently defaulted.
func parseLogLevel(lookup LookupFunc) (slog.Level, string) {
	raw, ok := lookup(KeyLogLevel)
	if !ok {
		return defaultLogLevel, ""
	}
	v := strings.TrimSpace(raw)
	if v == "" {
		return 0, "must not be empty when set"
	}
	if level, found := logLevels[v]; found {
		return level, ""
	}
	return 0, "must be one of debug|info|warn|error"
}

// parseAddr validates a host:port listen address. An absent key yields def; a
// present but empty value is rejected. The port must be numeric in 1..65535: port 0
// would bind an ephemeral port nobody can route to, so it is rejected.
func parseAddr(lookup LookupFunc, key, def string) (string, string) {
	raw, ok := lookup(key)
	if !ok {
		return def, ""
	}
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", "must not be empty when set"
	}
	host, port, err := net.SplitHostPort(v)
	if err != nil {
		return "", "must be a host:port listen address"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", "port must be a number in 1..65535"
	}
	if host != "" && net.ParseIP(host) == nil && !validHostname(host) {
		return "", "host must be an IP address or hostname"
	}
	return v, ""
}

// checkAddrCollisions rejects two listeners on the same port whose hosts may
// overlap. In particular the management plane can never share a socket with a
// sandbox-facing data plane.
func checkAddrCollisions(cfg Config) []Issue {
	type named struct{ key, addr string }
	all := []named{
		{KeyMgmtAddr, cfg.MgmtAddr}, {KeyHTTPProxyAddr, cfg.HTTPProxyAddr},
		{KeySOCKSAddr, cfg.SOCKSAddr}, {KeyDNSAddr, cfg.DNSAddr},
	}
	var issues []Issue
	for i := range all {
		for j := range i {
			if all[i].addr == "" || all[j].addr == "" {
				continue
			}
			hi, pi, _ := net.SplitHostPort(all[i].addr)
			hj, pj, _ := net.SplitHostPort(all[j].addr)
			if pi == pj && (hi == hj || isWildcard(hi) || isWildcard(hj)) {
				issues = append(issues, Issue{Key: all[i].key, Reason: "conflicts with " + all[j].key})
			}
		}
	}
	return issues
}

func isWildcard(host string) bool {
	return host == "" || host == "0.0.0.0" || host == "::"
}

func validHostname(h string) bool {
	if len(h) > 253 {
		return false
	}
	for _, label := range strings.Split(h, ".") {
		if label == "" || len(label) > 63 {
			return false
		}
		for _, r := range label {
			if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' {
				return false
			}
		}
	}
	return true
}

// parseRequired validates a required free-form key (no default, not empty).
func parseRequired(lookup LookupFunc, key string) (string, string) {
	raw, ok := lookup(key)
	if !ok {
		return "", "is required"
	}
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", "must not be empty"
	}
	return v, ""
}

var valkeySchemes = map[string]bool{"redis": true, "rediss": true, "valkey": true, "valkeys": true}

// parseValkeyURL validates VALKEY_URL: required, a redis/valkey URL with a host.
// Reasons never echo the value because it may carry a password.
func parseValkeyURL(lookup LookupFunc) (Secret, string) {
	v, reason := parseRequired(lookup, KeyValkeyURL)
	if reason != "" {
		return Secret{}, reason
	}
	u, err := url.Parse(v)
	if err != nil {
		return Secret{}, "must be a valid URL"
	}
	if !valkeySchemes[u.Scheme] {
		return Secret{}, "scheme must be one of redis|rediss|valkey|valkeys"
	}
	if u.Hostname() == "" {
		return Secret{}, "must include a host"
	}
	return NewSecret(v), ""
}

// parseOTLPEndpoint validates OTEL_EXPORTER_OTLP_ENDPOINT: optional; when set it
// must be an absolute http(s) URL without embedded credentials.
func parseOTLPEndpoint(lookup LookupFunc) (string, string) {
	raw, ok := lookup(KeyOTLPEndpoint)
	if !ok {
		return "", ""
	}
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", "must not be empty when set"
	}
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", "must be an absolute http(s) URL"
	}
	if u.User != nil {
		return "", "must not embed credentials"
	}
	return v, ""
}

// parseDrainTimeout validates GATEWAY_DRAIN_TIMEOUT as a Go duration in (0, 5m].
func parseDrainTimeout(lookup LookupFunc) (time.Duration, string) {
	raw, ok := lookup(KeyDrainTimeout)
	if !ok {
		return DefaultDrainTimeout, ""
	}
	v := strings.TrimSpace(raw)
	if v == "" {
		return 0, "must not be empty when set"
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, "must be a duration such as 10s"
	}
	if d <= 0 || d > maxDrainTimeout {
		return 0, "must be greater than 0 and at most 5m"
	}
	return d, ""
}

// parseDNSUpstream validates GATEWAY_DNS_UPSTREAM: optional; when set a host:port
// with a non-empty host (a listen-style bare ":53" would mean "this machine").
func parseDNSUpstream(lookup LookupFunc) (string, string) {
	v, reason := parseAddr(lookup, KeyDNSUpstream, "")
	if reason != "" {
		return "", reason
	}
	if host, _, _ := net.SplitHostPort(v); v != "" && host == "" {
		return "", "must include a host"
	}
	return v, ""
}

// parseDNSPinTTL validates GATEWAY_DNS_PIN_TTL as a Go duration in (0, 1h].
func parseDNSPinTTL(lookup LookupFunc) (time.Duration, string) {
	raw, ok := lookup(KeyDNSPinTTL)
	if !ok {
		return DefaultDNSPinTTL, ""
	}
	v := strings.TrimSpace(raw)
	if v == "" {
		return 0, "must not be empty when set"
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, "must be a duration such as 120s"
	}
	if d <= 0 || d > maxDNSPinTTL {
		return 0, "must be greater than 0 and at most 1h"
	}
	return d, ""
}

// parseStrictCNAME validates GATEWAY_DNS_STRICT_CNAME. Absent means true (the secure
// default); anything but "true" or "false" is rejected rather than read as false.
func parseStrictCNAME(lookup LookupFunc) (bool, string) {
	raw, ok := lookup(KeyDNSStrictCNAME)
	if !ok {
		return true, ""
	}
	switch strings.TrimSpace(raw) {
	case "true":
		return true, ""
	case "false":
		return false, ""
	}
	return false, "must be true or false"
}

func joinEnvironments() string {
	names := make([]string, 0, len(environments))
	for _, e := range environments {
		names = append(names, string(e))
	}
	return strings.Join(names, "|")
}
