package config_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/config"
)

type withSecret struct {
	Name  string
	Token config.Secret
}

func TestSecretRevealKeepsValueVerbatim(t *testing.T) {
	raw := "  pa ss\tword ü  "
	s := config.NewSecret(raw)
	assert.Equal(t, raw, s.Reveal(), "secrets are never trimmed or normalised")
	assert.False(t, s.IsZero())
	assert.True(t, config.Secret{}.IsZero())
}

func TestSecretIsRedactedByEveryFmtVerb(t *testing.T) {
	s := config.NewSecret(sentinel)
	holder := withSecret{Name: "valkey", Token: s}
	verbs := []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d", "%T-%v"}
	for _, verb := range verbs {
		for _, arg := range []any{s, &s, holder, &holder} {
			out := fmt.Sprintf(verb, arg)
			assert.NotContains(t, out, sentinel, "verb %s on %T", verb, arg)
			assert.NotContains(t, out, fmt.Sprintf("%x", sentinel), "hex leak via %s on %T", verb, arg)
		}
	}
	assert.Equal(t, "[REDACTED]", s.String())
	assert.Equal(t, "[REDACTED]", fmt.Sprint(s))
	assert.Equal(t, "{valkey [REDACTED]}", fmt.Sprintf("%v", holder))
}

func TestSecretIsRedactedInStructuredLogs(t *testing.T) {
	s := config.NewSecret(sentinel)
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	logger.Info("connecting", slog.Any("token", s), "raw", s, slog.Any("holder", withSecret{Name: "x", Token: s}))

	assert.NotContains(t, buf.String(), sentinel)
	assert.Contains(t, buf.String(), `"token":"[REDACTED]"`)

	var text bytes.Buffer
	slog.New(slog.NewTextHandler(&text, nil)).Info("connecting", "token", s)
	assert.NotContains(t, text.String(), sentinel)
}

func TestSecretIsRedactedInJSONAndText(t *testing.T) {
	s := config.NewSecret(sentinel)

	out, err := json.Marshal(withSecret{Name: "x", Token: s})
	require.NoError(t, err)
	assert.JSONEq(t, `{"Name":"x","Token":"[REDACTED]"}`, string(out))

	asKey, err := json.Marshal(map[config.Secret]int{s: 1})
	require.NoError(t, err)
	assert.NotContains(t, string(asKey), sentinel)

	txt, err := s.MarshalText()
	require.NoError(t, err)
	assert.Equal(t, "[REDACTED]", string(txt))
}

func TestSecretIsRedactedWhenWrappedInErrors(t *testing.T) {
	s := config.NewSecret(sentinel)
	err := fmt.Errorf("dial backend with %v: %w", s, errors.New("refused"))
	assert.NotContains(t, err.Error(), sentinel)
}
