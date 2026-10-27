package httpproxy

import (
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestLogger(w io.Writer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, nil))
}

func TestStripHopByHop(t *testing.T) {
	h := http.Header{}
	h.Set("Connection", "close, X-Custom")
	h.Add("Connection", "X-Second")
	h.Set("X-Custom", "1")
	h.Set("X-Second", "2")
	h.Set("Keep-Alive", "5")
	h.Set("Proxy-Connection", "keep-alive")
	h.Set("Proxy-Authorization", "Basic abc")
	h.Set("Proxy-Authenticate", "Basic")
	h.Set("Proxy-Anything-Else", "x")
	h.Set("Te", "trailers")
	h.Set("Trailer", "X-T")
	h.Set("Upgrade", "h2c")
	h.Set("Accept", "*/*")
	h.Set("X-Keep", "yes")

	stripHopByHop(h)
	assert.Equal(t, http.Header{"Accept": {"*/*"}, "X-Keep": {"yes"}}, h)
}

func TestHasUpgrade(t *testing.T) {
	for name, tc := range map[string]struct {
		h    map[string][]string
		want bool
	}{
		"none":              {map[string][]string{"Accept": {"*/*"}}, false},
		"upgrade header":    {map[string][]string{"Upgrade": {"websocket"}}, true},
		"connection token":  {map[string][]string{"Connection": {"keep-alive, Upgrade"}}, true},
		"http2 settings":    {map[string][]string{"Http2-Settings": {"AAMA"}}, true},
		"connection close":  {map[string][]string{"Connection": {"close"}}, false},
		"similar substring": {map[string][]string{"Connection": {"x-upgrade-not"}}, false},
	} {
		t.Run(name, func(t *testing.T) { assert.Equal(t, tc.want, hasUpgrade(tc.h)) })
	}
}

func TestParseTarget(t *testing.T) {
	ok := map[string]target{
		"http://Example.COM./a?b=1#frag": {"http", "example.com", 80, "http://example.com/a?b=1"},
		"http://[::1]:8080/":             {"http", "::1", 8080, "http://[::1]:8080/"},
		"http://10.0.0.1:65535":          {"http", "10.0.0.1", 65535, "http://10.0.0.1:65535"},
	}
	for raw, want := range ok {
		u, err := url.Parse(raw)
		require.NoError(t, err)
		got, err := parseTarget(u)
		require.NoError(t, err, raw)
		assert.Equal(t, want, got, raw)
	}
	for _, raw := range []string{"https://a/", "ftp://a/", "http://u:p@a/", "http://u@a/", "http:///x", "http://a:0/", "http://a:65536/", "mailto:a@b"} {
		u, err := url.Parse(raw)
		if err != nil {
			continue
		}
		_, err = parseTarget(u)
		assert.Error(t, err, raw)
	}
	_, err := parseTarget(nil)
	assert.Error(t, err)
}

func TestParseConnectTarget(t *testing.T) {
	got, err := parseConnectTarget("Example.COM.:443")
	require.NoError(t, err)
	assert.Equal(t, target{"https", "example.com", 443, "https://example.com:443"}, got)

	got, err = parseConnectTarget("[::1]:8443")
	require.NoError(t, err)
	assert.Equal(t, target{"https", "::1", 8443, "https://[::1]:8443"}, got)

	for _, bad := range []string{"", "example.com", ":443", "example.com:", "example.com:0", "example.com:70000", "example.com:abc", "a:b:c"} {
		_, err := parseConnectTarget(bad)
		assert.Error(t, err, bad)
	}
}
