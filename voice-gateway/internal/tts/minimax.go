// Package tts owns UMRAIO speech synthesis inside the media plane.
//
// WHY IT LIVES HERE: the control plane runs in a serverless Worker that
// forbids all runtime WebAssembly compilation, so it can never turn MiniMax
// PCM into the Opus packets WhatsApp Calling transmits. The gateway links
// libopus natively, so MiniMax synthesis and Opus encoding happen exactly once,
// next to the RTP sender.
//
// VOICE LOCK: provider MiniMax, model speech-2.8-hd, voice Malay_male_1_v1,
// language_boost Malay. There is NO substitute provider and NO substitute
// voice: a failure is reported as a failure and the caller hears silence.
//
// SECURITY: the API key is read from the environment, never logged, never
// returned and never included in an error. Reply text is never logged.
package tts

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	DefaultBaseURL  = "https://api.minimax.io/v1"
	DefaultModel    = "speech-2.8-hd"
	DefaultVoiceID  = "Malay_male_1_v1"
	DefaultBoost    = "Malay"
	DefaultTimeout  = 15 * time.Second
	SampleRateHz    = 24000
	Channels        = 1
	requestBitrate  = 128000
	maxResponseSize = 32 << 20
)

var (
	// ErrNotConfigured means no MiniMax credential is present: synthesis is
	// simply unavailable, which the pipeline reports instead of substituting.
	ErrNotConfigured = errors.New("tts: minimax not configured")
	ErrProvider      = errors.New("tts: minimax provider error")
	ErrEmptyAudio    = errors.New("tts: minimax returned no audio")
)

type Config struct {
	BaseURL string
	APIKey  string
	GroupID string
	Model   string
	VoiceID string
	Boost   string
	Timeout time.Duration
}

// LoadConfig reads the media-plane TTS environment. Returns ok=false when the
// gateway is deployed without a MiniMax key (synthesis stays disabled).
func LoadConfig(lookup func(string) (string, bool)) (Config, bool) {
	get := func(key, def string) string {
		if v, ok := lookup(key); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
		return def
	}
	key := get("MINIMAX_TTS_API_KEY", "")
	if key == "" {
		return Config{}, false
	}
	return Config{
		BaseURL: strings.TrimRight(get("MINIMAX_BASE_URL", DefaultBaseURL), "/"),
		APIKey:  key,
		GroupID: get("MINIMAX_GROUP_ID", ""),
		Model:   get("MINIMAX_TTS_MODEL", DefaultModel),
		VoiceID: get("MINIMAX_TTS_VOICE_ID", DefaultVoiceID),
		Boost:   get("MINIMAX_TTS_LANGUAGE_BOOST", DefaultBoost),
		Timeout: DefaultTimeout,
	}, true
}

// Client performs exactly ONE MiniMax request per reply. No provider retry, no
// container retry: a live call cannot afford a round trip it cannot transmit.
type Client struct {
	cfg  Config
	http *http.Client
}

func NewClient(cfg Config) *Client {
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultTimeout
	}
	if cfg.Model == "" {
		cfg.Model = DefaultModel
	}
	if cfg.VoiceID == "" {
		cfg.VoiceID = DefaultVoiceID
	}
	if cfg.Boost == "" {
		cfg.Boost = DefaultBoost
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = DefaultBaseURL
	}
	return &Client{cfg: cfg, http: &http.Client{Timeout: cfg.Timeout}}
}

// Model, VoiceID and Boost expose the LOCKED identity for diagnostics.
func (c *Client) Model() string   { return c.cfg.Model }
func (c *Client) VoiceID() string { return c.cfg.VoiceID }
func (c *Client) Boost() string   { return c.cfg.Boost }

type minimaxResponse struct {
	Data struct {
		Audio string `json:"audio"`
	} `json:"data"`
	BaseResp struct {
		StatusCode int `json:"status_code"`
	} `json:"base_resp"`
}

// SynthesizePCM returns s16le / 24 kHz / mono PCM for one reply.
// voiceID and boost override the configured identity only when non-empty; the
// control plane sends the same locked values, so a mismatch cannot go unseen.
func (c *Client) SynthesizePCM(ctx context.Context, text, voiceID, boost string) ([]byte, error) {
	if strings.TrimSpace(text) == "" {
		return nil, ErrEmptyAudio
	}
	if voiceID == "" {
		voiceID = c.cfg.VoiceID
	}
	if boost == "" {
		boost = c.cfg.Boost
	}
	body, err := json.Marshal(map[string]any{
		"model":          c.cfg.Model,
		"text":           text,
		"stream":         false,
		"language_boost": boost,
		"output_format":  "hex",
		"voice_setting": map[string]any{
			"voice_id": voiceID,
			"speed":    1,
			"vol":      1,
			"pitch":    0,
		},
		"audio_setting": map[string]any{
			"sample_rate": SampleRateHz,
			"bitrate":     requestBitrate,
			"format":      "pcm",
			"channel":     Channels,
		},
	})
	if err != nil {
		return nil, err
	}

	url := c.cfg.BaseURL + "/t2a_v2"
	if c.cfg.GroupID != "" {
		url += "?GroupId=" + c.cfg.GroupID
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: transport", ErrProvider)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Status only — a provider body may echo the reply text.
		return nil, fmt.Errorf("%w: http %d", ErrProvider, resp.StatusCode)
	}

	var out minimaxResponse
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, maxResponseSize)).Decode(&out); err != nil {
		return nil, fmt.Errorf("%w: decode", ErrProvider)
	}
	if out.BaseResp.StatusCode != 0 {
		return nil, fmt.Errorf("%w: status %d", ErrProvider, out.BaseResp.StatusCode)
	}
	if out.Data.Audio == "" {
		return nil, ErrEmptyAudio
	}
	pcm, err := hex.DecodeString(out.Data.Audio)
	if err != nil || len(pcm) < 2 {
		return nil, ErrEmptyAudio
	}
	return pcm, nil
}

// EnvConfig is the process-level convenience loader.
func EnvConfig() (Config, bool) { return LoadConfig(os.LookupEnv) }
