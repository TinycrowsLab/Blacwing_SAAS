package server

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/config"
)

// SnapshotFileProvider is the default PolicyProvider. It checks that the snapshot
// file at Path exists and is readable, but it never reports PolicyVerified:
// signature and envelope verification arrive with EGRESS-003, so until then the
// gateway stays fail closed even when a file is present.
type SnapshotFileProvider struct {
	Path string
}

// PolicyStatus implements PolicyProvider.
func (p SnapshotFileProvider) PolicyStatus(context.Context) PolicyStatus {
	f, err := os.Open(p.Path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return PolicyStatus{State: PolicyNotLoaded, Detail: "policy snapshot not present"}
	case err != nil:
		return PolicyStatus{State: PolicyUnreadable, Detail: "policy snapshot unreadable"}
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return PolicyStatus{State: PolicyUnreadable, Detail: "policy snapshot unreadable"}
	}
	// Probe a read so a file that opens but cannot be read is not reported loaded.
	if _, err := f.Read(make([]byte, 1)); err != nil && info.Size() > 0 {
		return PolicyStatus{State: PolicyUnreadable, Detail: "policy snapshot unreadable"}
	}
	return PolicyStatus{State: PolicyUnverified, Detail: "policy snapshot signature not verified"}
}

// ValkeyProbe is the default BudgetStore: it only answers Ping by speaking RESP
// (optional AUTH, then PING) over TCP, or TLS for rediss:// and valkeys://. The
// budget operations themselves arrive with EGRESS-004. Errors never include the
// URL, which may carry a password.
type ValkeyProbe struct {
	URL     config.Secret
	Timeout time.Duration
}

// Ping implements BudgetStore.
func (v ValkeyProbe) Ping(ctx context.Context) error {
	u, err := url.Parse(v.URL.Reveal())
	if err != nil {
		return errors.New("valkey: invalid URL")
	}
	timeout := v.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "6379"
	}
	addr := net.JoinHostPort(host, port)
	var conn net.Conn
	if u.Scheme == "rediss" || u.Scheme == "valkeys" {
		d := tls.Dialer{Config: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}}
		conn, err = d.DialContext(ctx, "tcp", addr)
	} else {
		var d net.Dialer
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("valkey %s unreachable", addr)
	}
	defer func() { _ = conn.Close() }()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}

	r := bufio.NewReader(conn)
	if u.User != nil {
		pass, hasPass := u.User.Password()
		args := []string{"AUTH", pass}
		if name := u.User.Username(); name != "" && hasPass {
			args = []string{"AUTH", name, pass}
		} else if !hasPass {
			args = []string{"AUTH", name}
		}
		if err := respCommand(conn, r, args, "+OK"); err != nil {
			return errors.New("valkey: authentication failed")
		}
	}
	if err := respCommand(conn, r, []string{"PING"}, "+PONG"); err != nil {
		return fmt.Errorf("valkey %s: ping failed", addr)
	}
	return nil
}

func respCommand(conn net.Conn, r *bufio.Reader, args []string, want string) error {
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	if _, err := conn.Write([]byte(b.String())); err != nil {
		return err
	}
	line, err := r.ReadString('\n')
	if err != nil {
		return err
	}
	if strings.TrimRight(line, "\r\n") != want {
		return errors.New("unexpected reply")
	}
	return nil
}
