package tts

// Speaker is the media plane's single speech producer: MiniMax text →
// PCM → native Opus packets. It NEVER substitutes another provider or voice.

import (
	"context"
	"log/slog"
	"time"
)

type Speaker struct {
	client *Client
	logger *slog.Logger
}

func NewSpeaker(cfg Config, logger *slog.Logger) *Speaker {
	if logger == nil {
		logger = slog.Default()
	}
	return &Speaker{client: NewClient(cfg), logger: logger}
}

// Available reports whether this build and configuration can actually speak.
func (s *Speaker) Available() bool { return s != nil && s.client != nil && EncoderAvailable() }

// Speak returns ready-to-send Opus packets for one reply. Errors carry a
// sanitized class only — never text, never credentials.
func (s *Speaker) Speak(ctx context.Context, callID, text, voiceID, boost string) ([][]byte, error) {
	if !s.Available() {
		return nil, ErrEncoder
	}
	started := time.Now()
	pcm, err := s.client.SynthesizePCM(ctx, text, voiceID, boost)
	if err != nil {
		s.logger.Warn("tts_failed",
			"call_id", callID, "provider", "minimax",
			"model", s.client.Model(), "voice", orDefault(voiceID, s.client.VoiceID()),
			"stage", "provider", "error_class", classOf(err))
		return nil, err
	}
	ttsMs := time.Since(started).Milliseconds()

	packets, err := EncodeOpus(pcm)
	if err != nil {
		s.logger.Warn("tts_failed",
			"call_id", callID, "provider", "minimax", "stage", "encode",
			"error_class", classOf(err))
		return nil, err
	}
	s.logger.Info("tts_ok",
		"call_id", callID, "provider", "minimax",
		"model", s.client.Model(), "voice", orDefault(voiceID, s.client.VoiceID()),
		"boost", orDefault(boost, s.client.Boost()),
		"packets", len(packets), "speech_ms", len(packets)*FrameMs,
		"provider_ms", ttsMs, "encode_ms", time.Since(started).Milliseconds()-ttsMs)
	return packets, nil
}

func classOf(err error) string {
	switch {
	case err == nil:
		return "none"
	case errorsIs(err, ErrNotConfigured):
		return "not_configured"
	case errorsIs(err, ErrEmptyAudio):
		return "empty_audio"
	case errorsIs(err, ErrVoiceIdentity):
		return "voice_identity"
	case errorsIs(err, ErrEncoder):
		return "encoder"
	case errorsIs(err, ErrProvider):
		return "provider"
	default:
		return "unknown"
	}
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
