package identity_test

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/identity"
)

const testToken = "tok_S3cr3t-Value.abc123"

func v7(t testing.TB) uuid.UUID {
	t.Helper()
	u, err := uuid.NewV7()
	require.NoError(t, err)
	return u
}

func TestParseValid(t *testing.T) {
	tc, role, sess, run := v7(t), v7(t), v7(t), v7(t)

	cases := map[string]struct {
		user  string
		check func(t *testing.T, id identity.RequestIdentity)
	}{
		"test case and role (pack §4.1 form)": {
			user: "tc_" + tc.String() + ".role_" + role.String(),
			check: func(t *testing.T, id identity.RequestIdentity) {
				assert.Equal(t, tc, id.TestCaseID)
				require.NotNil(t, id.RoleID)
				assert.Equal(t, role, *id.RoleID)
				assert.Equal(t, uuid.Nil, id.RunID)
				assert.Equal(t, uuid.Nil, id.SessionID)
			},
		},
		"unauthenticated test case has nil role": {
			user: "tc_" + tc.String(),
			check: func(t *testing.T, id identity.RequestIdentity) {
				assert.Equal(t, tc, id.TestCaseID)
				assert.Nil(t, id.RoleID)
			},
		},
		"all four segments": {
			user: fmt.Sprintf("tc_%s.role_%s.sess_%s.run_%s", tc, role, sess, run),
			check: func(t *testing.T, id identity.RequestIdentity) {
				assert.Equal(t, run, id.RunID)
				assert.Equal(t, sess, id.SessionID)
			},
		},
		"segments in any order": {
			user: fmt.Sprintf("run_%s.sess_%s.tc_%s", run, sess, tc),
			check: func(t *testing.T, id identity.RequestIdentity) {
				assert.Equal(t, tc, id.TestCaseID)
				assert.Equal(t, run, id.RunID)
			},
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			id, err := identity.Parse(c.user, testToken)
			require.NoError(t, err)
			assert.Equal(t, testToken, id.Token)
			c.check(t, id)
		})
	}
}

func TestParseRejects(t *testing.T) {
	tc, role := v7(t).String(), v7(t).String()
	v4 := uuid.New().String()
	good := "tc_" + tc + ".role_" + role

	cases := []struct {
		name, user, pass string
		reason           identity.Reason
	}{
		{"empty username", "", testToken, identity.ReasonMissingCredentials},
		{"empty password", good, "", identity.ReasonMissingCredentials},
		{"whitespace-only username", "  \t ", testToken, identity.ReasonMissingCredentials},
		{"whitespace-only password", good, "   ", identity.ReasonMissingCredentials},
		{"overlong username", good + "." + strings.Repeat("a", identity.MaxFieldLen), testToken, identity.ReasonTooLong},
		{"overlong password", good, strings.Repeat("x", identity.MaxFieldLen+1), identity.ReasonTooLong},
		{"invalid utf-8 username", good + "\xff", testToken, identity.ReasonInvalidUTF8},
		{"control char in username", "tc_" + tc + "\x00", testToken, identity.ReasonControlCharacter},
		{"newline in username", good + "\n", testToken, identity.ReasonControlCharacter},
		{"control char in password", good, "abc\x1bdef", identity.ReasonControlCharacter},
		{"C1 control in password", good, "abc\u0085def", identity.ReasonControlCharacter},
		{"unicode username", "tc_" + tc + ".role_é", testToken, identity.ReasonInvalidCharacter},
		{"unicode lookalike segment", "tс_" + tc, testToken, identity.ReasonInvalidCharacter}, // Cyrillic es
		{"uppercase uuid", "tc_" + strings.ToUpper(tc), testToken, identity.ReasonInvalidCharacter},
		{"space in token", good, "abc def", identity.ReasonInvalidCharacter},
		{"unicode token", good, "tökén", identity.ReasonInvalidCharacter},
		{"empty segment", "tc_" + tc + "..role_" + role, testToken, identity.ReasonMalformedSegment},
		{"trailing dot", good + ".", testToken, identity.ReasonMalformedSegment},
		{"segment without underscore", "tc" + tc, testToken, identity.ReasonMalformedSegment},
		{"segment with empty value", "tc_", testToken, identity.ReasonMalformedSegment},
		{"unknown segment", good + ".tenant_" + v7(t).String(), testToken, identity.ReasonUnknownSegment},
		{"duplicate tc segment", "tc_" + tc + ".tc_" + v7(t).String(), testToken, identity.ReasonDuplicateSegment},
		{"duplicate role segment", good + ".role_" + role, testToken, identity.ReasonDuplicateSegment},
		{"missing test case", "role_" + role, testToken, identity.ReasonMissingTestCase},
		{"non-uuid value", "tc_notauuid", testToken, identity.ReasonInvalidUUID},
		{"hyphenless uuid", "tc_" + strings.ReplaceAll(tc, "-", "") + "0000", testToken, identity.ReasonInvalidUUID},
		{"uuid with extra chars", "tc_" + tc + "-1", testToken, identity.ReasonInvalidUUID},
		{"uuidv4 test case", "tc_" + v4, testToken, identity.ReasonNotUUIDv7},
		{"uuidv4 role", "tc_" + tc + ".role_" + v4, testToken, identity.ReasonNotUUIDv7},
		{"nil uuid", "tc_" + uuid.Nil.String(), testToken, identity.ReasonNotUUIDv7},
		{"v7 with wrong variant", "tc_" + tc[:19] + "c" + tc[20:], testToken, identity.ReasonNotUUIDv7},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			id, err := identity.Parse(c.user, c.pass)
			require.Error(t, err)
			assert.ErrorIs(t, err, identity.ErrIdentityMalformed)
			assert.Equal(t, c.reason, identity.ReasonOf(err))
			assert.Equal(t, identity.RequestIdentity{}, id, "no partial identity on error")
			assert.NotContains(t, err.Error(), testToken)
		})
	}
}

func TestParseLengthBoundaryIsInclusive(t *testing.T) {
	tc := v7(t).String()
	_, err := identity.Parse("tc_"+tc, strings.Repeat("x", identity.MaxFieldLen))
	require.NoError(t, err, "exactly MaxFieldLen bytes is allowed")
}

func TestIdentityFormattingRedactsToken(t *testing.T) {
	id, err := identity.Parse("tc_"+v7(t).String(), testToken)
	require.NoError(t, err)

	for _, s := range []string{fmt.Sprint(id), fmt.Sprintf("%v %+v %#v %s", id, id, id, id)} {
		assert.NotContains(t, s, testToken)
		assert.Contains(t, s, identity.TokenFingerprint(testToken))
	}
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("x", slog.Any("identity", id))
	assert.NotContains(t, buf.String(), testToken)
	assert.Contains(t, buf.String(), identity.TokenFingerprint(testToken))
}

func TestTokenFingerprint(t *testing.T) {
	assert.Equal(t, "", identity.TokenFingerprint(""))
	fp := identity.TokenFingerprint(testToken)
	assert.Len(t, fp, 12)
	assert.Equal(t, fp, identity.TokenFingerprint(testToken))
	assert.NotEqual(t, fp, identity.TokenFingerprint(testToken+"x"))
}

func TestTokensEqual(t *testing.T) {
	assert.True(t, identity.TokensEqual(testToken, testToken))
	assert.False(t, identity.TokensEqual(testToken, testToken[:len(testToken)-1]))
	assert.False(t, identity.TokensEqual(testToken, ""))
}

func TestReasonOfForeignErrors(t *testing.T) {
	assert.Equal(t, identity.ReasonTokenRevoked, identity.ReasonOf(identity.ErrTokenRevoked))
	assert.Equal(t, identity.ReasonTokenExpired, identity.ReasonOf(identity.ErrTokenExpired))
	assert.Equal(t, identity.ReasonTokenUnknown, identity.ReasonOf(identity.ErrTokenInvalid))
	assert.Equal(t, identity.ReasonMalformedSegment, identity.ReasonOf(identity.ErrIdentityMalformed))
	assert.Equal(t, identity.ReasonVerifierUnavailable, identity.ReasonOf(errors.New("dial tcp: refused")))
}

// FuzzParse checks Parse never panics and that every accepted identity satisfies
// the grammar's invariants.
func FuzzParse(f *testing.F) {
	tc, role, sess, run := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	f.Add("tc_"+tc.String()+".role_"+role.String(), testToken)
	f.Add(fmt.Sprintf("tc_%s.role_%s.sess_%s.run_%s", tc, role, sess, run), "t")
	f.Add("tc_"+tc.String()+".tc_"+tc.String(), "t")
	f.Add("", "")
	f.Add("tc_\xff", "\x00")
	f.Add("....", "::::")
	f.Add("tc_"+uuid.New().String(), "tok")
	f.Fuzz(func(t *testing.T, user, pass string) {
		id, err := identity.Parse(user, pass)
		if err != nil {
			if !errors.Is(err, identity.ErrIdentityMalformed) {
				t.Fatalf("unexpected error kind: %v", err)
			}
			if id != (identity.RequestIdentity{}) {
				t.Fatalf("partial identity returned on error")
			}
			return
		}
		if len(user) > identity.MaxFieldLen || len(pass) > identity.MaxFieldLen || id.Token != pass {
			t.Fatalf("accepted out-of-bounds input")
		}
		if id.TestCaseID.Version() != 7 {
			t.Fatalf("accepted non-v7 test case id")
		}
		if id.RoleID != nil && id.RoleID.Version() != 7 {
			t.Fatalf("accepted non-v7 role id")
		}
	})
}
