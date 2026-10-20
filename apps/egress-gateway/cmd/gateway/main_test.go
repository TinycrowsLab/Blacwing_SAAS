package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/config"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/obs"
)

const sentinel = "s3cr3t-sentinel-value-0xDEADBEEF"

// execEnv makes the test binary act as the real gateway process (re-exec pattern),
// so the SIGTERM test exercises main(), signal handling and the exit code.
const execEnv = "BW_EGRESS_TEST_EXEC_MAIN"

func TestMain(m *testing.M) {
	if os.Getenv(execEnv) == "1" {
		os.Args = append([]string{os.Args[0]}, strings.Fields(os.Getenv(execEnv+"_ARGS"))...)
		main()
		return
	}
	os.Exit(m.Run())
}

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

// freeAddr returns a loopback address with a currently free port.
func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	require.NoError(t, ln.Close())
	return addr
}

// validEnv is a complete, valid environment with the management plane on a free
// loopback port and Valkey pointed at a closed port (unreachable).
func validEnv(t *testing.T, extra map[string]string) map[string]string {
	t.Helper()
	env := map[string]string{
		"BW_ENV":                "test",
		"GATEWAY_MGMT_ADDR":     freeAddr(t),
		"POLICY_SNAPSHOT_PATH":  t.TempDir() + "/policy.snapshot",
		"VALKEY_URL":            "redis://" + freeAddr(t) + "/0",
		"GATEWAY_DRAIN_TIMEOUT": "2s",
	}
	for k, v := range extra {
		env[k] = v
	}
	return env
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

func findMsg(lines []map[string]any, msg string) map[string]any {
	for _, l := range lines {
		if l["msg"] == msg {
			return l
		}
	}
	return nil
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
	env := validEnv(t, nil)
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
	r := invoke(context.Background(), validEnv(t, nil), "check-config")
	assert.Equal(t, exitOK, r.code)
	assert.Equal(t, "egress-gateway: configuration valid ("+strings.Join(config.Keys(), ", ")+")\n", r.stdout)
}

func TestCheckConfigInvalidFailsClosedWithoutLeakingValues(t *testing.T) {
	r := invoke(context.Background(), map[string]string{"LOG_LEVEL": sentinel, "VALKEY_URL": "http://" + sentinel}, "check-config")
	assert.Equal(t, exitError, r.code)
	assert.Contains(t, r.stderr, "BW_ENV: is required")
	assert.Contains(t, r.stderr, "LOG_LEVEL: must be one of")
	assert.Contains(t, r.stderr, "POLICY_SNAPSHOT_PATH: is required")
	assert.NotContains(t, r.stderr+r.stdout, sentinel)
}

// Fail closed: with invalid configuration `run` exits non-zero before starting and
// logs keys and reasons only, as JSON.
func TestRunRefusesToStartOnInvalidConfig(t *testing.T) {
	r := invoke(context.Background(), validEnv(t, map[string]string{"BW_ENV": sentinel}), "run")
	assert.Equal(t, exitError, r.code)
	assert.NotContains(t, r.stderr+r.stdout, sentinel)

	lines := jsonLines(t, r.stderr)
	require.Len(t, lines, 1)
	assert.Equal(t, "ERROR", lines[0]["level"])
	assert.Equal(t, "configuration invalid: refusing to start", lines[0]["msg"])
	assert.Equal(t, "bootstrap", lines[0]["component"])
	assert.Equal(t, []any{"BW_ENV"}, lines[0]["invalid_keys"])
}

// Acceptance: invalid config (bad addr) exits non-zero with a clear error, and no
// listener is bound (edge case: missing/empty required config).
func TestRunRejectsBadAddressAndMissingKeysWithoutBinding(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"bad addr":       validEnv(t, map[string]string{"GATEWAY_MGMT_ADDR": "localhost"}),
		"missing valkey": {"BW_ENV": "test", "POLICY_SNAPSHOT_PATH": "/x"},
		"empty policy":   validEnv(t, map[string]string{"POLICY_SNAPSHOT_PATH": ""}),
	} {
		t.Run(name, func(t *testing.T) {
			r := invoke(context.Background(), env, "run")
			assert.Equal(t, exitError, r.code)
			lines := jsonLines(t, r.stderr)
			require.Len(t, lines, 1, "nothing starts after a config error")
			assert.Equal(t, "configuration invalid: refusing to start", lines[0]["msg"])
		})
	}
	r := invoke(context.Background(), validEnv(t, map[string]string{"GATEWAY_MGMT_ADDR": "localhost"}), "run")
	assert.Contains(t, r.stderr, `"GATEWAY_MGMT_ADDR":"must be a host:port listen address"`)
}

// Edge case: port already in use -> fatal startup error, non-zero exit.
func TestRunFailsWhenManagementPortInUse(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = ln.Close() }()

	r := invoke(context.Background(), validEnv(t, map[string]string{"GATEWAY_MGMT_ADDR": ln.Addr().String()}), "run")
	assert.Equal(t, exitError, r.code)
	failed := findMsg(jsonLines(t, r.stderr), "egress gateway failed")
	require.NotNil(t, failed)
	assert.Contains(t, failed["error"], "bind management listener")
}

func TestRunHoldsDenyAllPostureUntilCancelled(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	done := make(chan result, 1)
	env := validEnv(t, map[string]string{"LOG_LEVEL": "debug", "VALKEY_URL": "redis://:" + sentinel + "@" + freeAddr(t) + "/0"})
	go func() { done <- invoke(ctx, env, "run") }()

	select {
	case r := <-done:
		t.Fatalf("run returned before cancellation: %+v", r)
	case <-time.After(200 * time.Millisecond):
	}
	cancel(errors.New("test shutdown"))

	var r result
	select {
	case r = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("run did not stop after cancellation")
	}
	assert.Equal(t, exitOK, r.code, r.stderr)
	assert.NotContains(t, r.stderr, sentinel, "the Valkey password is never logged")

	lines := jsonLines(t, r.stderr)
	for _, l := range lines {
		for _, key := range []string{"ts", "level", "msg", "service", "version", "component"} {
			assert.Contains(t, l, key, "%v", l)
		}
		assert.NotContains(t, l, "time", "time is renamed to ts")
		assert.Equal(t, "egress-gateway", l["service"])
	}
	assert.Equal(t, "egress gateway starting", lines[0]["msg"])
	assert.Equal(t, "deny_all", lines[1]["posture"])
	started := findMsg(lines, "egress gateway started")
	require.NotNil(t, started)
	assert.Equal(t, false, started["ready"])
	changed := findMsg(lines, "readiness changed")
	require.NotNil(t, changed)
	assert.Equal(t, false, changed["ready"])
	assert.Equal(t, "policy_not_loaded", changed["reason"])
	exited := lines[len(lines)-1]
	assert.Equal(t, "egress gateway exited", exited["msg"])
	assert.Equal(t, "test shutdown", exited["reason"])
}

func TestRunHonoursLogLevel(t *testing.T) {
	r := invoke(cancelled(), validEnv(t, map[string]string{"LOG_LEVEL": "error"}), "run")
	assert.Equal(t, exitOK, r.code)
	assert.Empty(t, jsonLines(t, r.stderr), "nothing passes an error threshold on a clean run")
}

func TestLogConfigErrorHandlesNonValidationErrors(t *testing.T) {
	var buf bytes.Buffer
	logConfigError(obs.NewLogger(&buf, slog.LevelInfo, version), errors.New("boom"))
	lines := jsonLines(t, buf.String())
	require.Len(t, lines, 1)
	assert.Equal(t, "boom", lines[0]["error"])
}

func get(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := http.Get(url) // #nosec G107 -- loopback test URL built by the test
	if err != nil {
		return 0, ""
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, ""
	}
	return resp.StatusCode, string(b)
}

// Integration (real process): the binary starts, /healthz is 200, /readyz is 503
// (no verified snapshot), /metrics shows egress_ready 0, and SIGTERM triggers a
// graceful drain that completes within GATEWAY_DRAIN_TIMEOUT with exit code 0.
func TestProcessServesHealthAndDrainsOnSIGTERM(t *testing.T) {
	if testing.Short() {
		t.Skip("process integration test")
	}
	env := validEnv(t, nil)
	cmd := exec.Command(os.Args[0]) // #nosec G204 G702 -- re-executes this test binary
	cmd.Env = append(os.Environ(), execEnv+"=1", execEnv+"_ARGS=run")
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	require.NoError(t, cmd.Start())
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })

	base := "http://" + env["GATEWAY_MGMT_ADDR"]
	require.Eventually(t, func() bool {
		code, _ := get(t, base+"/healthz")
		return code == http.StatusOK
	}, 10*time.Second, 50*time.Millisecond, "healthz never became 200")

	// Before the first check completes the reason is "starting"; either way 503.
	code, _ := get(t, base+"/readyz")
	assert.Equal(t, http.StatusServiceUnavailable, code)
	require.Eventually(t, func() bool {
		c, b := get(t, base+"/readyz")
		return c == http.StatusServiceUnavailable && strings.Contains(b, `"reason":"policy_not_loaded"`)
	}, 10*time.Second, 50*time.Millisecond)

	code, body := get(t, base+"/metrics")
	assert.Equal(t, http.StatusOK, code)
	assert.Contains(t, body, "egress_ready 0")
	assert.Contains(t, body, "egress_up 1")
	assert.Contains(t, body, `egress_build_info{commit="unknown",version="dev"} 1`)

	sw := obs.StartStopwatch()
	require.NoError(t, cmd.Process.Signal(syscall.SIGTERM))
	select {
	case err := <-exited:
		require.NoError(t, err, "graceful drain exits 0; stderr: %s", stderr.String())
	case <-time.After(5 * time.Second):
		t.Fatalf("process did not exit after SIGTERM; stderr: %s", stderr.String())
	}
	assert.Less(t, sw.Elapsed(), 2*time.Second+time.Second, "drain finished within the timeout")

	lines := jsonLines(t, stderr.String())
	assert.NotNil(t, findMsg(lines, "egress gateway draining"))
	stopped := findMsg(lines, "egress gateway stopped")
	require.NotNil(t, stopped)
	assert.Equal(t, false, stopped["timed_out"])
	var events []string
	for _, l := range lines {
		if l["msg"] == "audit event" {
			ev, ok := l["event"].(string)
			require.True(t, ok)
			events = append(events, ev)
			assert.Len(t, l["config_hash"], 64)
		}
	}
	assert.Equal(t, []string{"gateway.started", "gateway.stopped"}, events)
}
