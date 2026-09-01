// Package auth implements the HMAC session-token and request-signing scheme
// used between the UMRAIO control plane (Cloudflare Worker) and this media
// gateway. The gateway never holds Meta, Supabase, ASR or TTS credentials.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// TokenScope is the only scope this gateway accepts.
const TokenScope = "voice.media"

// MaxTokenLifetime bounds how long a minted token may claim to be valid.
const MaxTokenLifetime = 15 * time.Minute

// Claims is the payload of a single-call scoped session token.
// It intentionally carries no credentials of any kind.
type Claims struct {
	CallID        string `json:"call_id"`
	AgencyID      string `json:"agency_id"`
	PhoneNumberID string `json:"phone_number_id"`
	IssuedAt      int64  `json:"iat"`
	ExpiresAt     int64  `json:"exp"`
	Nonce         string `json:"nonce"`
	Scope         string `json:"scope"`
}

var (
	ErrMalformedToken   = errors.New("auth: malformed token")
	ErrBadSignature     = errors.New("auth: invalid signature")
	ErrExpired          = errors.New("auth: token expired")
	ErrNotYetValid      = errors.New("auth: token not yet valid")
	ErrMissingClaim     = errors.New("auth: missing required claim")
	ErrWrongScope       = errors.New("auth: wrong scope")
	ErrCallIDMismatch   = errors.New("auth: call_id mismatch")
	ErrLifetimeTooLong  = errors.New("auth: token lifetime exceeds maximum")
	ErrReplayed         = errors.New("auth: token replayed")
	ErrEmptySecret      = errors.New("auth: empty secret")
	ErrForbiddenClaim   = errors.New("auth: token carries a forbidden credential claim")
	clockSkewTolerance  = 60 * time.Second
	forbiddenClaimNames = []string{
		"access_token", "accesstoken", "meta_token", "service_role",
		"service_key", "supabase", "api_key", "apikey", "secret",
		"openai", "minimax", "tts_key", "asr_key", "authorization",
	}
)

var b64 = base64.RawURLEncoding

// Mint produces a signed token. It exists so tests (and any future Go-side
// tooling) can produce the exact bytes the Worker's TypeScript minter produces.
func Mint(secret string, c Claims) (string, error) {
	if secret == "" {
		return "", ErrEmptySecret
	}
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	body := b64.EncodeToString(payload)
	return body + "." + b64.EncodeToString(sign(secret, body)), nil
}

// Verify validates signature, structure, expiry, scope and call correlation.
// Replay protection is applied separately by the ReplayGuard so that the caller
// controls when a nonce is burned.
func Verify(secret, token, expectedCallID string, now time.Time) (Claims, error) {
	var c Claims
	if secret == "" {
		return c, ErrEmptySecret
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return c, ErrMalformedToken
	}
	got, err := b64.DecodeString(parts[1])
	if err != nil {
		return c, ErrMalformedToken
	}
	if !hmac.Equal(got, sign(secret, parts[0])) {
		return c, ErrBadSignature
	}
	raw, err := b64.DecodeString(parts[0])
	if err != nil {
		return c, ErrMalformedToken
	}
	if err := rejectForbiddenClaims(raw); err != nil {
		return c, err
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	if err := dec.Decode(&c); err != nil {
		return c, ErrMalformedToken
	}

	switch {
	case c.CallID == "", c.AgencyID == "", c.PhoneNumberID == "", c.Nonce == "":
		return c, ErrMissingClaim
	case c.IssuedAt == 0 || c.ExpiresAt == 0:
		return c, ErrMissingClaim
	case c.Scope != TokenScope:
		return c, ErrWrongScope
	}

	iat := time.Unix(c.IssuedAt, 0)
	exp := time.Unix(c.ExpiresAt, 0)
	if !exp.After(iat) {
		return c, ErrMalformedToken
	}
	if exp.Sub(iat) > MaxTokenLifetime {
		return c, ErrLifetimeTooLong
	}
	if now.After(exp) {
		return c, ErrExpired
	}
	if now.Add(clockSkewTolerance).Before(iat) {
		return c, ErrNotYetValid
	}
	if expectedCallID != "" && c.CallID != expectedCallID {
		return c, ErrCallIDMismatch
	}
	return c, nil
}

// rejectForbiddenClaims is defence in depth: a control plane bug must never be
// able to smuggle a credential into the media plane.
func rejectForbiddenClaims(raw []byte) error {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return ErrMalformedToken
	}
	for k := range probe {
		lower := strings.ToLower(k)
		for _, bad := range forbiddenClaimNames {
			if strings.Contains(lower, bad) {
				return fmt.Errorf("%w: %s", ErrForbiddenClaim, lower)
			}
		}
	}
	return nil
}

func sign(secret, body string) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(body))
	return m.Sum(nil)
}
