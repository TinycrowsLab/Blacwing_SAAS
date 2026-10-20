package config

import (
	"fmt"
	"log/slog"
)

// redacted is what every rendering of a Secret produces.
const redacted = "[REDACTED]"

// Secret holds a sensitive configuration value (a credential, token or a URL with
// embedded credentials). It is the Go counterpart of the TypeScript Secret brand:
// every formatting path (fmt verbs, slog, encoding/json, encoding.TextMarshaler)
// renders "[REDACTED]", so a Secret cannot reach logs or errors by accident
// (CONTEXT_PACK §8.7). Only Reveal returns the plaintext, at the point of use.
//
// The zero value is an empty secret.
type Secret struct {
	value string
}

// NewSecret wraps a sensitive value. The value is kept verbatim (never trimmed).
func NewSecret(value string) Secret {
	return Secret{value: value}
}

// Reveal returns the plaintext. Call it only where the value is used (for example
// when dialling a backend), never to log or format it.
func (s Secret) Reveal() string {
	return s.value
}

// IsZero reports whether the secret is empty.
func (s Secret) IsZero() bool {
	return s.value == ""
}

// String implements fmt.Stringer.
func (Secret) String() string {
	return redacted
}

// GoString implements fmt.GoStringer so %#v is redacted too.
func (Secret) GoString() string {
	return redacted
}

// Format implements fmt.Formatter so that every verb (%v, %+v, %s, %q, %x, %d, ...)
// prints the redaction marker instead of the value or its bytes.
func (Secret) Format(f fmt.State, _ rune) {
	_, _ = f.Write([]byte(redacted))
}

// LogValue implements slog.LogValuer.
func (Secret) LogValue() slog.Value {
	return slog.StringValue(redacted)
}

// MarshalText implements encoding.TextMarshaler (also used by encoding/json for
// map keys and by many config/serialisation libraries).
func (Secret) MarshalText() ([]byte, error) {
	return []byte(redacted), nil
}

// MarshalJSON implements json.Marshaler.
func (Secret) MarshalJSON() ([]byte, error) {
	return []byte(`"` + redacted + `"`), nil
}
