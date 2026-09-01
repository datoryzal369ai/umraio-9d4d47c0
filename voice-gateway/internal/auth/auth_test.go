package auth

import (
	"strconv"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

const testSecret = "0123456789abcdef0123456789abcdef0123456789"

func validClaims(now time.Time) Claims {
	return Claims{
		CallID: "wacid.ABC123", AgencyID: "ag_1", PhoneNumberID: "pn_1",
		IssuedAt: now.Unix(), ExpiresAt: now.Add(10 * time.Minute).Unix(),
		Nonce: "n-1", Scope: TokenScope,
	}
}

func TestVerifyAcceptsValidToken(t *testing.T) {
	now := time.Now()
	tok, err := Mint(testSecret, validClaims(now))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(testSecret, tok, "wacid.ABC123", now)
	if err != nil {
		t.Fatalf("expected valid token, got %v", err)
	}
	if got.AgencyID != "ag_1" || got.PhoneNumberID != "pn_1" {
		t.Fatalf("claims not round-tripped: %+v", got)
	}
}

func TestVerifyRejectsExpiredToken(t *testing.T) {
	now := time.Now()
	tok, _ := Mint(testSecret, validClaims(now.Add(-20*time.Minute)))
	if _, err := Verify(testSecret, tok, "wacid.ABC123", now); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected ErrExpired, got %v", err)
	}
}

func TestVerifyRejectsBadSignature(t *testing.T) {
	now := time.Now()
	tok, _ := Mint(testSecret, validClaims(now))
	if _, err := Verify("another-secret-that-is-long-enough-000000", tok, "wacid.ABC123", now); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("expected ErrBadSignature, got %v", err)
	}
}

func TestVerifyRejectsTamperedPayload(t *testing.T) {
	now := time.Now()
	tok, _ := Mint(testSecret, validClaims(now))
	parts := strings.Split(tok, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[0])
	tampered := strings.Replace(string(raw), "ag_1", "ag_9", 1)
	forged := base64.RawURLEncoding.EncodeToString([]byte(tampered)) + "." + parts[1]
	if _, err := Verify(testSecret, forged, "wacid.ABC123", now); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("expected ErrBadSignature, got %v", err)
	}
}

func TestVerifyRejectsMissingClaim(t *testing.T) {
	now := time.Now()
	c := validClaims(now)
	c.PhoneNumberID = ""
	tok, _ := Mint(testSecret, c)
	if _, err := Verify(testSecret, tok, "wacid.ABC123", now); !errors.Is(err, ErrMissingClaim) {
		t.Fatalf("expected ErrMissingClaim, got %v", err)
	}
}

func TestVerifyRejectsWrongCallID(t *testing.T) {
	now := time.Now()
	tok, _ := Mint(testSecret, validClaims(now))
	if _, err := Verify(testSecret, tok, "wacid.OTHER", now); !errors.Is(err, ErrCallIDMismatch) {
		t.Fatalf("expected ErrCallIDMismatch, got %v", err)
	}
}

func TestVerifyRejectsWrongScope(t *testing.T) {
	now := time.Now()
	c := validClaims(now)
	c.Scope = "voice.turn"
	tok, _ := Mint(testSecret, c)
	if _, err := Verify(testSecret, tok, "wacid.ABC123", now); !errors.Is(err, ErrWrongScope) {
		t.Fatalf("expected ErrWrongScope, got %v", err)
	}
}

func TestVerifyRejectsOverlongLifetime(t *testing.T) {
	now := time.Now()
	c := validClaims(now)
	c.ExpiresAt = now.Add(2 * time.Hour).Unix()
	tok, _ := Mint(testSecret, c)
	if _, err := Verify(testSecret, tok, "wacid.ABC123", now); !errors.Is(err, ErrLifetimeTooLong) {
		t.Fatalf("expected ErrLifetimeTooLong, got %v", err)
	}
}

func TestVerifyRejectsCredentialBearingToken(t *testing.T) {
	now := time.Now()
	payload := map[string]any{
		"call_id": "wacid.ABC123", "agency_id": "ag_1", "phone_number_id": "pn_1",
		"iat": now.Unix(), "exp": now.Add(time.Minute).Unix(), "nonce": "n-1",
		"scope": TokenScope, "access_token": "EAAG-should-never-be-here",
	}
	raw, _ := json.Marshal(payload)
	body := base64.RawURLEncoding.EncodeToString(raw)
	tok := body + "." + base64.RawURLEncoding.EncodeToString(sign(testSecret, body))
	if _, err := Verify(testSecret, tok, "wacid.ABC123", now); !errors.Is(err, ErrForbiddenClaim) {
		t.Fatalf("expected ErrForbiddenClaim, got %v", err)
	}
}

func TestVerifyRejectsMalformed(t *testing.T) {
	now := time.Now()
	for _, bad := range []string{"", "onlyonepart", "a.b.c", ".", "!!!.???"} {
		if _, err := Verify(testSecret, bad, "wacid.ABC123", now); err == nil {
			t.Fatalf("expected rejection for %q", bad)
		}
	}
}

func TestReplayGuardBurnsNonceOnce(t *testing.T) {
	g := NewReplayGuard(time.Minute)
	if err := g.Use("call-1", "n-1"); err != nil {
		t.Fatalf("first use should succeed: %v", err)
	}
	if err := g.Use("call-1", "n-1"); !errors.Is(err, ErrReplayed) {
		t.Fatalf("expected ErrReplayed, got %v", err)
	}
	if err := g.Use("call-2", "n-1"); err != nil {
		t.Fatalf("different call should be allowed: %v", err)
	}
}

func TestReplayGuardEvictsAfterTTL(t *testing.T) {
	base := time.Now()
	g := NewReplayGuard(time.Second)
	g.SetClock(func() time.Time { return base })
	_ = g.Use("call-1", "n-1")
	g.SetClock(func() time.Time { return base.Add(10 * time.Second) })
	if g.Size() != 0 {
		t.Fatalf("expected eviction, size=%d", g.Size())
	}
}

func TestVerifyRequestSignature(t *testing.T) {
	now := time.Now()
	body := []byte(`{"event":"media_ready"}`)
	sig := SignRequest(testSecret, now.Unix(), body)
	if err := VerifyRequest(testSecret, sig, itoa(now.Unix()), body, now); err != nil {
		t.Fatalf("expected valid request signature: %v", err)
	}
	if err := VerifyRequest(testSecret, sig, itoa(now.Unix()), []byte(`{"event":"x"}`), now); !errors.Is(err, ErrBadRequestSig) {
		t.Fatalf("expected ErrBadRequestSig, got %v", err)
	}
	old := now.Add(-30 * time.Minute)
	if err := VerifyRequest(testSecret, SignRequest(testSecret, old.Unix(), body), itoa(old.Unix()), body, now); !errors.Is(err, ErrStaleRequest) {
		t.Fatalf("expected ErrStaleRequest, got %v", err)
	}
	if err := VerifyRequest(testSecret, "", "", body, now); !errors.Is(err, ErrMissingSigParts) {
		t.Fatalf("expected ErrMissingSigParts, got %v", err)
	}
}

func itoa(v int64) string { return strconv.FormatInt(v, 10) }
