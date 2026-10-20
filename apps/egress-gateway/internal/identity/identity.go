// Package identity parses and validates the proxy identity every sandbox request
// carries (CONTEXT_PACK §4.1): the proxy-auth username encodes the test case, role,
// session and run, and the password is a short-lived per-session token.
//
//	http://tc_<testCaseId>.role_<roleId>:<token>@egress:3128
//
// The same user/password pair arrives over HTTP (Proxy-Authorization: Basic) and
// SOCKS5 (RFC 1929 username/password). Both paths call Parse once with the decoded
// strings and then Authenticator.Authenticate, which verifies the token through a
// TokenVerifier and re-checks the run/session binding deterministically.
//
// Every failure is a deny (fail closed, CONTEXT_PACK §8.2/§8.11): a malformed
// identity or an unverifiable token yields HTTP 407 or a SOCKS auth failure before
// any upstream connection is attempted. The token never appears in logs, errors,
// audit events or String output; only a SHA-256 prefix is ever recorded (§8.7).
package identity

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

// MaxFieldLen is the maximum length in bytes of the username and of the password.
const MaxFieldLen = 512

// Username segment prefixes.
const (
	prefixTestCase = "tc"
	prefixRole     = "role"
	prefixSession  = "sess"
	prefixRun      = "run"
)

// Sentinel error kinds. Every error returned by this package wraps exactly one of
// them, so callers can branch with errors.Is. All of them mean deny.
var (
	// ErrIdentityMalformed: the username or password does not follow the grammar.
	ErrIdentityMalformed = errors.New("identity malformed")
	// ErrTokenInvalid: the token is unknown, bound to another run/session, or could
	// not be verified (verifier unreachable; fail closed).
	ErrTokenInvalid = errors.New("token invalid")
	// ErrTokenRevoked: the token was revoked (for example by a kill).
	ErrTokenRevoked = errors.New("token revoked")
	// ErrTokenExpired: the token's expiry is at or before now.
	ErrTokenExpired = errors.New("token expired")
)

// Reason is a bounded, value-free rejection reason code used in errors, metrics,
// logs and audit events. It never contains input data.
type Reason string

// Rejection reasons.
const (
	ReasonMissingCredentials  Reason = "missing_credentials"
	ReasonTooLong             Reason = "too_long"
	ReasonInvalidUTF8         Reason = "invalid_utf8"
	ReasonControlCharacter    Reason = "control_character"
	ReasonInvalidCharacter    Reason = "invalid_character"
	ReasonMalformedSegment    Reason = "malformed_segment"
	ReasonUnknownSegment      Reason = "unknown_segment"
	ReasonDuplicateSegment    Reason = "duplicate_segment"
	ReasonMissingTestCase     Reason = "missing_test_case"
	ReasonInvalidUUID         Reason = "invalid_uuid"
	ReasonNotUUIDv7           Reason = "not_uuidv7"
	ReasonMalformedHeader     Reason = "malformed_header"
	ReasonTokenUnknown        Reason = "token_unknown"
	ReasonTokenRevoked        Reason = "token_revoked"
	ReasonTokenExpired        Reason = "token_expired"
	ReasonRunMismatch         Reason = "run_mismatch"
	ReasonSessionMismatch     Reason = "session_mismatch"
	ReasonTestCaseMismatch    Reason = "test_case_mismatch"
	ReasonClaimsIncomplete    Reason = "claims_incomplete"
	ReasonVerifierUnavailable Reason = "verifier_unavailable"
)

// AllReasons lists every reason code (used to pre-initialise metric series).
var AllReasons = []Reason{
	ReasonMissingCredentials, ReasonTooLong, ReasonInvalidUTF8, ReasonControlCharacter,
	ReasonInvalidCharacter, ReasonMalformedSegment, ReasonUnknownSegment, ReasonDuplicateSegment,
	ReasonMissingTestCase, ReasonInvalidUUID, ReasonNotUUIDv7, ReasonMalformedHeader,
	ReasonTokenUnknown, ReasonTokenRevoked, ReasonTokenExpired, ReasonRunMismatch,
	ReasonSessionMismatch, ReasonTestCaseMismatch, ReasonClaimsIncomplete, ReasonVerifierUnavailable,
}

// Error is a rejection: a sentinel kind plus a reason code. Its message never
// contains the username or the token.
type Error struct {
	Kind   error
	Reason Reason
}

func (e *Error) Error() string { return fmt.Sprintf("identity: %v (%s)", e.Kind, e.Reason) }

// Unwrap returns the sentinel kind.
func (e *Error) Unwrap() error { return e.Kind }

func reject(kind error, reason Reason) *Error { return &Error{Kind: kind, Reason: reason} }

// ReasonOf returns the reason code carried by err. A foreign error (for example a
// verifier backend failure) that wraps no token kind is ReasonVerifierUnavailable;
// every error still means deny.
func ReasonOf(err error) Reason {
	var e *Error
	if errors.As(err, &e) {
		return e.Reason
	}
	switch {
	case errors.Is(err, ErrTokenRevoked):
		return ReasonTokenRevoked
	case errors.Is(err, ErrTokenExpired):
		return ReasonTokenExpired
	case errors.Is(err, ErrTokenInvalid):
		return ReasonTokenUnknown
	case errors.Is(err, ErrIdentityMalformed):
		return ReasonMalformedSegment
	default:
		return ReasonVerifierUnavailable
	}
}

// RequestIdentity is the parsed proxy identity of one sandbox request.
//
// RunID and SessionID are uuid.Nil when the username omits them; after
// Authenticator.Authenticate they are always set from the verified token claims.
// RoleID is nil for unauthenticated test cases. Token is opaque and secret: it is
// redacted by String, GoString and LogValue.
type RequestIdentity struct {
	RunID      uuid.UUID
	SessionID  uuid.UUID
	TestCaseID uuid.UUID
	RoleID     *uuid.UUID
	Token      string
}

// TokenFingerprint returns the first 12 hex characters of SHA-256(token), the only
// form of the token that may be logged or audited. Empty tokens give "".
func TokenFingerprint(token string) string {
	if token == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])[:12]
}

// String renders the identity with the token redacted.
func (id RequestIdentity) String() string {
	role := "none"
	if id.RoleID != nil {
		role = id.RoleID.String()
	}
	return fmt.Sprintf("identity{run=%s session=%s test_case=%s role=%s token_sha256_prefix=%s}",
		id.RunID, id.SessionID, id.TestCaseID, role, TokenFingerprint(id.Token))
}

// GoString keeps %#v from printing the token.
func (id RequestIdentity) GoString() string { return id.String() }

// LogValue keeps slog from printing the token.
func (id RequestIdentity) LogValue() slog.Value {
	attrs := []slog.Attr{
		slog.String("run_id", id.RunID.String()),
		slog.String("session_id", id.SessionID.String()),
		slog.String("test_case_id", id.TestCaseID.String()),
		slog.String("token_sha256_prefix", TokenFingerprint(id.Token)),
	}
	if id.RoleID != nil {
		attrs = append(attrs, slog.String("role_id", id.RoleID.String()))
	}
	return slog.GroupValue(attrs...)
}

// Parse validates the decoded proxy username and password and returns the
// identity. Username grammar (dot separated, each prefix at most once, any order):
//
//	tc_<uuidv7>[.role_<uuidv7>][.sess_<uuidv7>][.run_<uuidv7>]
//
// UUIDs must be canonical lowercase UUIDv7. Both fields must be non-blank, at most
// MaxFieldLen bytes, valid UTF-8 without control characters; the username is
// restricted to [a-z0-9._-] and the token to printable ASCII. On error the returned
// identity is the zero value.
func Parse(user, pass string) (RequestIdentity, error) {
	id, err := parse(user, pass)
	if err != nil {
		return RequestIdentity{}, err
	}
	return id, nil
}

// parse is Parse but keeps the fields parsed before an error so a rejection can
// still be correlated (run_id/session_id in logs and audit). The partial identity
// is never used for authorisation and never carries the token.
func parse(user, pass string) (RequestIdentity, error) {
	if err := checkField(user, isUsernameByte); err != nil {
		return RequestIdentity{}, err
	}
	id, err := parseUsername(user)
	if err != nil {
		return id, err
	}
	if err := checkField(pass, isTokenByte); err != nil {
		return id, err
	}
	id.Token = pass
	return id, nil
}

func checkField(s string, allowed func(byte) bool) error {
	if strings.TrimSpace(s) == "" {
		return reject(ErrIdentityMalformed, ReasonMissingCredentials)
	}
	if len(s) > MaxFieldLen {
		return reject(ErrIdentityMalformed, ReasonTooLong)
	}
	if !utf8.ValidString(s) {
		return reject(ErrIdentityMalformed, ReasonInvalidUTF8)
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) || r == ' ' || r == ' ' {
			return reject(ErrIdentityMalformed, ReasonControlCharacter)
		}
	}
	for i := 0; i < len(s); i++ {
		if !allowed(s[i]) {
			return reject(ErrIdentityMalformed, ReasonInvalidCharacter)
		}
	}
	return nil
}

func isUsernameByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '.' || b == '_' || b == '-'
}

// isTokenByte allows printable ASCII except space.
func isTokenByte(b byte) bool { return b > 0x20 && b < 0x7f }

func parseUsername(user string) (RequestIdentity, error) {
	var id RequestIdentity
	seen := make(map[string]bool, 4)
	for seg := range strings.SplitSeq(user, ".") {
		key, val, ok := strings.Cut(seg, "_")
		if !ok || key == "" || val == "" {
			return id, reject(ErrIdentityMalformed, ReasonMalformedSegment)
		}
		switch key {
		case prefixTestCase, prefixRole, prefixSession, prefixRun:
		default:
			return id, reject(ErrIdentityMalformed, ReasonUnknownSegment)
		}
		if seen[key] {
			return id, reject(ErrIdentityMalformed, ReasonDuplicateSegment)
		}
		seen[key] = true
		u, err := parseUUIDv7(val)
		if err != nil {
			return id, err
		}
		switch key {
		case prefixTestCase:
			id.TestCaseID = u
		case prefixRole:
			id.RoleID = &u
		case prefixSession:
			id.SessionID = u
		case prefixRun:
			id.RunID = u
		}
	}
	if !seen[prefixTestCase] {
		return id, reject(ErrIdentityMalformed, ReasonMissingTestCase)
	}
	return id, nil
}

// parseUUIDv7 accepts only the canonical 36-character lowercase form of an RFC 9562
// version-7 UUID (no braces, urn: prefix or hyphen-less form).
func parseUUIDv7(s string) (uuid.UUID, error) {
	if len(s) != 36 {
		return uuid.Nil, reject(ErrIdentityMalformed, ReasonInvalidUUID)
	}
	u, err := uuid.Parse(s)
	if err != nil || u.String() != s {
		return uuid.Nil, reject(ErrIdentityMalformed, ReasonInvalidUUID)
	}
	if u.Version() != 7 || u.Variant() != uuid.RFC4122 {
		return uuid.Nil, reject(ErrIdentityMalformed, ReasonNotUUIDv7)
	}
	return u, nil
}
