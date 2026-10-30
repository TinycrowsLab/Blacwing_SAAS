// Command egress-gateway is Blackwing's scoped egress proxy: the only route from run
// sandboxes to targets (HTTP(S) MITM, SOCKS5, scoped DNS), enforcing the signed
// authorisation envelope and failing closed (CONTEXT_PACK §4.1, §8.1, §8.2).
//
// This build is the EGRESS-001 chassis: typed configuration, structured JSON logs,
// Prometheus metrics, OpenTelemetry tracing, the management plane (/healthz,
// /readyz, /metrics) and a graceful SIGTERM/SIGINT drain, plus the HTTP/1.1 forward
// proxy (EGRESS-005) registered with a fail-closed token verifier and policy
// evaluator until those land. The gateway is never ready, and so no data plane
// starts, until a verified policy snapshot is loaded (EGRESS-003), so every egress
// attempt is denied.
//
// Usage:
//
//	egress-gateway run            start the gateway (blocks until SIGINT/SIGTERM)
//	egress-gateway check-config   validate the environment and exit
//	egress-gateway version        print build information
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/config"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/httpproxy"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/identity"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/obs"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/server"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/telemetry"
)

// Build information, overridden at link time by the Makefile
// (-ldflags "-X main.version=... -X main.commit=...").
var (
	version = "dev"
	commit  = "unknown"
)

// Process exit codes.
const (
	exitOK     = 0
	exitError  = 1 // invalid configuration or runtime failure: refuse to run
	exitUsage  = 2 // unknown command or bad arguments
	usageLines = `Usage: egress-gateway <command>

Commands:
  run            start the gateway; blocks until SIGINT/SIGTERM
  check-config   validate the environment configuration and exit
  version        print build information
  help           show this help

Configuration is read from the environment (see README.md). Any missing or
invalid key makes the gateway refuse to start (fail closed).
`
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

// run dispatches the CLI. It is free of process globals so tests can drive it.
func run(ctx context.Context, args []string, lookup config.LookupFunc, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		writeOut(stderr, usageLines)
		return exitUsage
	}

	cmd, rest := args[0], args[1:]
	switch cmd {
	case "run":
		if !noArgs(cmd, rest, stderr) {
			return exitUsage
		}
		return cmdRun(ctx, lookup, stderr)
	case "check-config":
		if !noArgs(cmd, rest, stderr) {
			return exitUsage
		}
		return cmdCheckConfig(lookup, stdout, stderr)
	case "version":
		if !noArgs(cmd, rest, stderr) {
			return exitUsage
		}
		writeOut(stdout, versionString()+"\n")
		return exitOK
	case "help", "-h", "-help", "--help":
		writeOut(stdout, usageLines)
		return exitOK
	default:
		writeOut(stderr, fmt.Sprintf("egress-gateway: unknown command %q\n\n%s", cmd, usageLines))
		return exitUsage
	}
}

// noArgs parses the (currently flag-less) argument list of a subcommand and rejects
// anything left over, so typos never silently change behaviour.
func noArgs(cmd string, args []string, stderr io.Writer) bool {
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.SetOutput(stderr)
	if err := fs.Parse(args); err != nil {
		return false
	}
	if fs.NArg() > 0 {
		writeOut(stderr, fmt.Sprintf("egress-gateway %s: unexpected arguments %q\n", cmd, fs.Args()))
		return false
	}
	return true
}

// cmdRun loads the configuration and runs the gateway until ctx is cancelled.
// Invalid configuration exits non-zero before any listener is bound.
func cmdRun(ctx context.Context, lookup config.LookupFunc, logOut io.Writer) int {
	cfg, err := config.Load(lookup)
	if err != nil {
		// The level is not known yet: log at the default level.
		logConfigError(obs.NewLogger(logOut, slog.LevelInfo, version), err)
		return exitError
	}

	logger := obs.NewLogger(logOut, cfg.LogLevel, version)
	boot := obs.Component(logger, obs.ComponentBootstrap)
	boot.Info("egress gateway starting",
		slog.Any("config", *cfg),
		slog.Any("config_keys", config.Keys()),
		slog.String("config_hash", cfg.Hash()),
	)
	// Fail closed: the HTTP proxy is registered but its token verifier and policy
	// evaluator are not wired in this build (EGRESS-003/010), so it answers 407/403 to
	// every request; data planes only start after a verified policy snapshot is loaded.
	boot.Warn("token verifier and policy evaluator not wired in this build: all egress denied",
		slog.String("posture", "deny_all"),
	)

	tel, err := telemetry.Setup(ctx, cfg.OTLPEndpoint, version)
	if err != nil {
		boot.Error("telemetry setup failed: refusing to start", slog.String("error", err.Error()))
		return exitError
	}
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if ferr := tel.Shutdown(flushCtx); ferr != nil {
			boot.Warn("telemetry shutdown failed", slog.String("error", ferr.Error()))
		}
	}()
	tp := tel.Tracer
	_, startup := tp.Tracer(obs.ServiceName).Start(ctx, "egress.startup")

	metrics := obs.NewMetrics(version, commit)
	auth, err := identity.NewAuthenticator(identity.Options{Logger: logger, Registerer: metrics.Registry, Tracer: tp.Tracer(obs.ServiceName)})
	if err != nil {
		boot.Error("identity setup failed: refusing to start", slog.String("error", err.Error()))
		return exitError
	}
	httpPlane, err := httpproxy.New(httpproxy.Options{
		Addr:           cfg.HTTPProxyAddr,
		ReadTimeout:    cfg.ReadTimeout,
		WriteTimeout:   cfg.WriteTimeout,
		IdleTimeout:    cfg.IdleTimeout,
		MaxHeaderBytes: cfg.MaxHeaderBytes,
		MITMEnabled:    cfg.MITMEnabled,
		Auth:           auth,
		Logger:         logger,
		Registerer:     metrics.Registry,
		Tracer:         tp,
		Meter:          tel.Meter,
	})
	if err != nil {
		boot.Error("http proxy setup failed: refusing to start", slog.String("error", err.Error()))
		return exitError
	}

	gw, err := server.New(server.Options{
		Config:     cfg,
		Logger:     logger,
		Metrics:    metrics,
		DataPlanes: []server.DataPlane{httpPlane},
		Version:    version,
		Commit:     commit,
		Tracer:     tp,
		Telemetry:  tp,
	})
	if err != nil {
		boot.Error("gateway setup failed: refusing to start", slog.String("error", err.Error()))
		return exitError
	}
	startup.End()
	if err := gw.Run(ctx); err != nil {
		boot.Error("egress gateway failed", slog.String("error", err.Error()),
			slog.String("reason", stopReason(ctx)))
		return exitError
	}
	boot.Info("egress gateway exited", slog.String("reason", stopReason(ctx)))
	return exitOK
}

// cmdCheckConfig validates the environment and reports keys (never values).
func cmdCheckConfig(lookup config.LookupFunc, stdout, stderr io.Writer) int {
	if _, err := config.Load(lookup); err != nil {
		writeOut(stderr, "egress-gateway: "+err.Error()+"\n")
		return exitError
	}
	writeOut(stdout, "egress-gateway: configuration valid ("+strings.Join(config.Keys(), ", ")+")\n")
	return exitOK
}

func logConfigError(logger *slog.Logger, err error) {
	attrs := []any{slog.String(obs.FieldComponent, obs.ComponentBootstrap)}
	var verr *config.ValidationError
	if errors.As(err, &verr) {
		attrs = append(attrs, slog.Any("issues", verr), slog.Any("invalid_keys", verr.Keys()))
	} else {
		attrs = append(attrs, slog.String("error", err.Error()))
	}
	logger.Error("configuration invalid: refusing to start", attrs...)
}

func stopReason(ctx context.Context) string {
	if ctx.Err() == nil {
		return "fatal error"
	}
	if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) {
		return cause.Error()
	}
	return "signal"
}

func versionString() string {
	return fmt.Sprintf("%s %s (commit %s, %s, %s/%s)",
		obs.ServiceName, version, commit, runtime.Version(), runtime.GOOS, runtime.GOARCH)
}

// writeOut writes CLI output. A failed write to stdout/stderr cannot be reported
// anywhere more useful, so the error is deliberately ignored.
func writeOut(w io.Writer, s string) {
	_, _ = io.WriteString(w, s)
}
