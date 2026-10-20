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
// Later EGRESS issues extend Config with their own keys (listener addresses, policy
// snapshot path, Valkey URL, ...) by adding fields and a matching parse step in Load.
// Keys that carry credentials must be stored as Secret.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
)

// Environment keys read by Load.
const (
	// KeyEnv selects the deployment environment. Required, no default.
	KeyEnv = "BW_ENV"
	// KeyLogLevel sets the minimum log level. Optional, defaults to "info".
	KeyLogLevel = "LOG_LEVEL"
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
}

// Keys returns the environment keys the loader understands, sorted. It is used to
// log which keys were resolved without logging their values.
func Keys() []string {
	keys := []string{KeyEnv, KeyLogLevel}
	sort.Strings(keys)
	return keys
}

// LogValue renders the configuration for structured logs. Every field is listed
// explicitly so that a field added later (for example a Secret) is never dumped by
// reflection; Secret fields must render through Secret.LogValue.
func (c Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("env", string(c.Env)),
		slog.String("log_level", strings.ToLower(c.LogLevel.String())),
	)
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
	cfg := Config{}

	if env, reason := parseEnvironment(lookup); reason != "" {
		issues = append(issues, Issue{Key: KeyEnv, Reason: reason})
	} else {
		cfg.Env = env
	}

	if level, reason := parseLogLevel(lookup); reason != "" {
		issues = append(issues, Issue{Key: KeyLogLevel, Reason: reason})
	} else {
		cfg.LogLevel = level
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

func joinEnvironments() string {
	names := make([]string, 0, len(environments))
	for _, e := range environments {
		names = append(names, string(e))
	}
	return strings.Join(names, "|")
}
