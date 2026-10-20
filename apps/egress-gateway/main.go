// Command egress-gateway is Blackwing's scoped egress proxy: the only route from run
// sandboxes to targets (HTTP(S) MITM, SOCKS5, scoped DNS), enforcing the signed
// authorisation envelope and failing closed (CONTEXT_PACK §4.1, §8.1, §8.2).
//
// This is the FOUND-013 skeleton: it validates configuration, sets up structured
// JSON logging and a signal-driven lifecycle, but binds no data-plane listener, so
// every egress attempt is denied by construction. The EGRESS epic fills in the
// listeners, policy evaluation, budgets and capture.
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

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/config"
)

// Build information, overridden at link time by the Makefile
// (-ldflags "-X main.version=... -X main.commit=...").
var (
	version = "dev"
	commit  = "unknown"
)

const serviceName = "egress-gateway"

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

// cmdRun loads the configuration, then holds the deny-all skeleton posture until the
// context is cancelled. Invalid configuration exits non-zero before anything starts.
func cmdRun(ctx context.Context, lookup config.LookupFunc, logOut io.Writer) int {
	cfg, err := config.Load(lookup)
	if err != nil {
		// The level is not known yet: log at the default level.
		logConfigError(newLogger(logOut, slog.LevelInfo), err)
		return exitError
	}

	logger := newLogger(logOut, cfg.LogLevel).With(slog.String("component", "bootstrap"))
	logger.Info("egress gateway starting",
		slog.Any("config", *cfg),
		slog.Any("config_keys", config.Keys()),
	)
	// Fail closed: no data-plane listener exists in this build, so nothing can be
	// forwarded. The EGRESS epic binds listeners only after a verified policy snapshot.
	logger.Warn("data plane not implemented in this build: no listeners bound, all egress denied",
		slog.String("posture", "deny_all"),
	)

	<-ctx.Done()
	logger.Info("egress gateway stopped", slog.String("reason", stopReason(ctx)))
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
	attrs := []any{slog.String("component", "bootstrap")}
	var verr *config.ValidationError
	if errors.As(err, &verr) {
		attrs = append(attrs, slog.Any("issues", verr), slog.Any("invalid_keys", verr.Keys()))
	} else {
		attrs = append(attrs, slog.String("error", err.Error()))
	}
	logger.Error("configuration invalid: refusing to start", attrs...)
}

// newLogger returns the service's structured JSON logger. Field names follow the
// EGRESS logging contract (ts, level, msg, component, ...) and will align with the
// OpenTelemetry log data model when telemetry is wired in.
func newLogger(w io.Writer, level slog.Level) *slog.Logger {
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) == 0 && a.Key == slog.TimeKey {
				a.Key = "ts"
				a.Value = slog.StringValue(a.Value.Time().UTC().Format("2006-01-02T15:04:05.000Z07:00"))
			}
			return a
		},
	})
	return slog.New(h).With(
		slog.String("service", serviceName),
		slog.String("version", version),
	)
}

func stopReason(ctx context.Context) string {
	if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) {
		return cause.Error()
	}
	return "signal"
}

func versionString() string {
	return fmt.Sprintf("%s %s (commit %s, %s, %s/%s)",
		serviceName, version, commit, runtime.Version(), runtime.GOOS, runtime.GOARCH)
}

// writeOut writes CLI output. A failed write to stdout/stderr cannot be reported
// anywhere more useful, so the error is deliberately ignored.
func writeOut(w io.Writer, s string) {
	_, _ = io.WriteString(w, s)
}
