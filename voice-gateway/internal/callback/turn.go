package callback

// TurnClient carries one conversation turn to the UMRAIO control plane.
// The gateway never reasons about content: it sends caller audio and plays back
// whatever audio the control plane returns. Requests are HMAC-signed with the
// same shared secret and freshness window as lifecycle callbacks.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/umraio/voice-gateway/internal/auth"
	"github.com/umraio/voice-gateway/internal/media"
)

// TurnPath is the control-plane endpoint that owns ASR, reasoning and TTS.
const TurnPath = "/api/public/voice/turn"

// MaxTurnResponseBytes bounds one synthesised reply (~60 s of Opus, base64).
const MaxTurnResponseBytes = 4 << 20

type TurnClient struct {
	baseURL string
	secret  string
	http    *http.Client
	nowFunc func() time.Time
}

func NewTurnClient(baseURL, secret string, timeout time.Duration) *TurnClient {
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	return &TurnClient{
		baseURL: baseURL,
		secret:  secret,
		http:    &http.Client{Timeout: timeout},
		nowFunc: time.Now,
	}
}

// Turn performs exactly one signed round trip. It is deliberately NOT retried:
// a duplicated utterance would make UMRAIO answer the caller twice.
func (c *TurnClient) Turn(ctx context.Context, in media.TurnRequest) (*media.TurnResponse, error) {
	body, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+TurnPath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	ts := c.nowFunc().Unix()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.TimestampHeader, fmt.Sprintf("%d", ts))
	req.Header.Set(auth.SignatureHeader, auth.SignRequest(c.secret, ts, body))

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("turn: control plane responded %d", resp.StatusCode)
	}
	var out media.TurnResponse
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, MaxTurnResponseBytes)).Decode(&out); err != nil {
		return nil, fmt.Errorf("turn: %w", err)
	}
	return &out, nil
}
