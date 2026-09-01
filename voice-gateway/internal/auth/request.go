package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

// SignatureHeader / TimestampHeader carry the request-level HMAC that protects
// every control-plane <-> media-plane HTTP hop, in both directions.
const (
	SignatureHeader = "X-Umraio-Signature"
	TimestampHeader = "X-Umraio-Timestamp"
	signaturePrefix = "v1="
)

// MaxRequestSkew rejects stale or future-dated signed requests.
const MaxRequestSkew = 5 * time.Minute

var (
	ErrBadTimestamp    = errors.New("auth: invalid timestamp header")
	ErrStaleRequest    = errors.New("auth: request timestamp outside allowed skew")
	ErrBadRequestSig   = errors.New("auth: invalid request signature")
	ErrMissingSigParts = errors.New("auth: missing signature headers")
)

// SignRequest returns the value for SignatureHeader over "<timestamp>.<body>".
func SignRequest(secret string, tsUnix int64, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(strconv.FormatInt(tsUnix, 10)))
	m.Write([]byte("."))
	m.Write(body)
	return signaturePrefix + hex.EncodeToString(m.Sum(nil))
}

// VerifyRequest performs a timing-safe check of a signed request.
func VerifyRequest(secret, sigHeader, tsHeader string, body []byte, now time.Time) error {
	if secret == "" {
		return ErrEmptySecret
	}
	if sigHeader == "" || tsHeader == "" {
		return ErrMissingSigParts
	}
	ts, err := strconv.ParseInt(strings.TrimSpace(tsHeader), 10, 64)
	if err != nil {
		return ErrBadTimestamp
	}
	delta := now.Unix() - ts
	if delta < 0 {
		delta = -delta
	}
	if time.Duration(delta)*time.Second > MaxRequestSkew {
		return ErrStaleRequest
	}
	expected := SignRequest(secret, ts, body)
	if !hmac.Equal([]byte(sigHeader), []byte(expected)) {
		return ErrBadRequestSig
	}
	return nil
}
