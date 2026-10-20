package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/config"
)

const sentinel = "s3cr3t-sentinel-value-0xDEADBEEF"

type result struct {
	code   int
	stdout string
	stderr string
}

func invoke(ctx context.Context, env map[string]string, args ...string) result {
	var out, errOut bytes.Buffer
	code := run(ctx, args, config.MapLookup(env), &out, &errOut)
	return result{code: code, stdout: out.String(), stderr: errOut.String()}
}

// jsonLines decodes every line of s as a JSON object; it fails on non-JSON output.
func jsonLines(t *testing.T, s string) []map[string]any {
	t.Helper()
	var lines []map[string]any
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		var m map[string]any
		require.NoError(t, json.Unmarshal(sc.Bytes(), &m), "log line is not JSON: %s", sc.Text())
		lines = append(lines, m)
	}
	require.NoError(t, sc.Err())
	return lines
}

func cancelled() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

func TestNoArgumentsPrintsUsageAndFails(t *testing.T) {
	r := invoke(context.Background(), nil)
	assert.Equal(t, exitUsage, r.code)
	assert.Contains(t, r.stderr, "Usage: egress-gateway <command>")
	assert.Empty(t, r.stdout)
}

func TestUnknownCommandFails(t *testing.T) {
	r := invoke(context.Background(), nil, "serve")
	assert.Equal(t, exitUsage, r.code)
	assert.Contains(t, r.stderr, `unknown command "serve"`)
}

func TestHelpSucceeds(t *testing.T) {
	for _, arg := range []string{"help", "-h", "--help"} {
		r := invoke(context.Background(), nil, arg)
		assert.Equal(t, exitOK, r.code, arg)
		assert.Contains(t, r.stdout, "check-config", arg)
	}
}

func TestSubcommandsRejectUnexpectedArguments(t *testing.T) {
	env := map[string]string{"BW_ENV": "test"}
	for _, args := range [][]string{
		{"run", "extra"},
		{"check-config", "--fail-open"},
		{"version", "now"},
	} {
		r := invoke(cancelled(), env, args...)
		assert.Equal(t, exitUsage, r.code, "%v", args)
	}
}

func TestVersionPrintsBuildInfo(t *testing.T) {
	r := invoke(context.Background(), nil, "version")
	assert.Equal(t, exitOK, r.code)
	assert.True(t, strings.HasPrefix(r.stdout, "egress-gateway dev (commit unknown, go"), r.stdout)
}

func TestCheckConfigValid(t *testing.T) {
	r := invoke(context.Background(), map[string]string{"BW_ENV": "dev"}, "check-config")
	assert.Equal(t, exitOK, r.code)
	assert.Equal(t, "egress-gateway: configuration valid (BW_ENV, LOG_LEVEL)\n", r.stdout)
}

func TestCheckConfigInvalidFailsClosedWithoutLeakingValues(t *testing.T) {
	r := invoke(context.Background(), map[string]string{"LOG_LEVEL": sentinel}, "check-config")
	assert.Equal(t, exitError, r.code)
	assert.Contains(t, r.stderr, "BW_ENV: is required")
	assert.Contains(t, r.stderr, "LOG_LEVEL: must be one of")
	assert.NotContains(t, r.stderr+r.stdout, sentinel)
}

// Fail closed: with invalid configuration `run` exits non-zero before starting and
// logs keys and reasons only, as JSON.
func TestRunRefusesToStartOnInvalidConfig(t *testing.T) {
	r := invoke(context.Background(), map[string]string{"BW_ENV": sentinel}, "run")
	assert.Equal(t, exitError, r.code)
	assert.NotContains(t, r.stderr+r.stdout, sentinel)

	lines := jsonLines(t, r.stderr)
	require.Len(t, lines, 1)
	assert.Equal(t, "ERROR", lines[0]["level"])
	assert.Equal(t, "configuration invalid: refusing to start", lines[0]["msg"])
	assert.Equal(t, "bootstrap", lines[0]["component"])
	assert.Equal(t, []any{"BW_ENV"}, lines[0]["invalid_keys"])
}

func TestRunHoldsDenyAllPostureUntilCancelled(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	done := make(chan result, 1)
	go func() {
		done <- invoke(ctx, map[string]string{"BW_ENV": "test", "LOG_LEVEL": "debug"}, "run")
	}()

	select {
	case r := <-done:
		t.Fatalf("run returned before cancellation: %+v", r)
	case <-time.After(50 * time.Millisecond):
	}
	cancel(errors.New("test shutdown"))

	var r result
	select {
	case r = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("run did not stop after cancellation")
	}
	assert.Equal(t, exitOK, r.code)

	lines := jsonLines(t, r.stderr)
	require.Len(t, lines, 3)
	for _, l := range lines {
		for _, key := range []string{"ts", "level", "msg", "service", "version", "component"} {
			assert.Contains(t, l, key)
		}
		assert.NotContains(t, l, "time", "time is renamed to ts")
		assert.Equal(t, "egress-gateway", l["service"])
	}
	assert.Equal(t, "egress gateway starting", lines[0]["msg"])
	assert.Equal(t, map[string]any{"env": "test", "log_level": "debug"}, lines[0]["config"])
	assert.Equal(t, "deny_all", lines[1]["posture"])
	assert.Equal(t, "egress gateway stopped", lines[2]["msg"])
	assert.Equal(t, "test shutdown", lines[2]["reason"])
}

func TestRunStopsOnSignalCancellation(t *testing.T) {
	r := invoke(cancelled(), map[string]string{"BW_ENV": "dev"}, "run")
	assert.Equal(t, exitOK, r.code)
	lines := jsonLines(t, r.stderr)
	require.NotEmpty(t, lines)
	assert.Equal(t, "signal", lines[len(lines)-1]["reason"])
}

func TestRunHonoursLogLevel(t *testing.T) {
	r := invoke(cancelled(), map[string]string{"BW_ENV": "dev", "LOG_LEVEL": "warn"}, "run")
	assert.Equal(t, exitOK, r.code)
	lines := jsonLines(t, r.stderr)
	require.Len(t, lines, 1, "only the deny-all warning passes a warn threshold")
	assert.Equal(t, "WARN", lines[0]["level"])
}

func TestLoggerWritesUTCTimestampsAsTs(t *testing.T) {
	var buf bytes.Buffer
	newLogger(&buf, slog.LevelDebug).Debug("hello", slog.String("k", "v"))
	lines := jsonLines(t, buf.String())
	require.Len(t, lines, 1)
	ts, ok := lines[0]["ts"].(string)
	require.True(t, ok)
	parsed, err := time.Parse(time.RFC3339Nano, ts)
	require.NoError(t, err)
	assert.Equal(t, time.UTC, parsed.Location())
	assert.True(t, strings.HasSuffix(ts, "Z"))
	assert.Equal(t, "v", lines[0]["k"])
}

func TestLogConfigErrorHandlesNonValidationErrors(t *testing.T) {
	var buf bytes.Buffer
	logConfigError(newLogger(&buf, slog.LevelInfo), errors.New("boom"))
	lines := jsonLines(t, buf.String())
	require.Len(t, lines, 1)
	assert.Equal(t, "boom", lines[0]["error"])
}
