// Package callback delivers media-plane lifecycle events to the UMRAIO control
// plane. Every request is HMAC-signed. The gateway never asserts business
// truth: the Worker correlates on call_id and decides what the event means.
package callback

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/umraio/voice-gateway/internal/auth"
)

type Event struct {
	Event           string `json:"event"`
	CallID          string `json:"call_id"`
	SessionID       string `json:"session_id"`
	Timestamp       string `json:"timestamp"`
	Nonce           string `json:"nonce"`
	InboundPackets  uint64 `json:"inbound_packets,omitempty"`
	OutboundPackets uint64 `json:"outbound_packets,omitempty"`
	Reason          string `json:"reason,omitempty"`
}

// Event names. media_ready is the only one that may unblock "answered" in the
// control plane, and only in combination with a successful Meta accept.
const (
	EventMediaReady   = "media_ready"
	EventMediaFailed  = "media_failed"
	EventTerminated   = "media_terminated"
	EventNegotiating  = "media_negotiating"
	CallbackEventPath = "/api/internal/voice/events"
)

type Client struct {
	baseURL    string
	secret     string
	http       *http.Client
	retryMax   int
	retryBase  time.Duration
	nowFunc    func() time.Time
	nonceMaker func() string
}

func New(baseURL, secret string, timeout time.Duration, retryMax int, retryBase time.Duration) *Client {
	return &Client{
		baseURL: baseURL, secret: secret,
		http:      &http.Client{Timeout: timeout},
		retryMax:  retryMax,
		retryBase: retryBase,
		nowFunc:   time.Now,
		nonceMaker: func() string {
			b := make([]byte, 16)
			_, _ = rand.Read(b)
			return hex.EncodeToString(b)
		},
	}
}

// Send delivers one event with bounded exponential backoff. Lifecycle events
// are idempotent on (call_id, event) in the control plane.
func (c *Client) Send(ctx context.Context, ev Event) error {
	if ev.Nonce == "" {
		ev.Nonce = c.nonceMaker()
	}
	if ev.Timestamp == "" {
		ev.Timestamp = c.nowFunc().UTC().Format(time.RFC3339Nano)
	}
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}

	var lastErr error
	attempts := c.retryMax
	if attempts < 1 {
		attempts = 1
	}
	for i := 0; i < attempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(c.retryBase * time.Duration(1<<uint(i-1))):
			}
		}
		lastErr = c.post(ctx, body)
		if lastErr == nil {
			return nil
		}
	}
	return lastErr
}

func (c *Client) post(ctx context.Context, body []byte) error {
	ts := c.nowFunc().Unix()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+CallbackEventPath, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.TimestampHeader, fmt.Sprintf("%d", ts))
	req.Header.Set(auth.SignatureHeader, auth.SignRequest(c.secret, ts, body))

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	return fmt.Errorf("callback: control plane responded %d", resp.StatusCode)
}
