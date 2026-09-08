package media

import (
	"context"
	"testing"
	"time"
)

// The VAD hangover is measured from the LAST speech frame to the moment the
// utterance closes — the silence the caller actually experiences.
func TestSegmenterRecordsSpeechEnd(t *testing.T) {
	now := time.Unix(0, 0)
	seg := NewSegmenter(VADConfig{FrameMs: 10, SpeechMinBytes: 40, StartFrames: 2, EndSilenceMs: 30, MinUtteranceMs: 10}).
		WithClock(func() time.Time { return now })

	for i := 0; i < 5; i++ {
		now = now.Add(10 * time.Millisecond)
		seg.Push(OpusFrame{Data: make([]byte, 120)})
	}
	speechEnd := now
	var event VADEvent
	for i := 0; i < 5; i++ {
		now = now.Add(10 * time.Millisecond)
		event, _ = seg.Push(OpusFrame{Data: make([]byte, 3)})
		if event == VADUtteranceEnd {
			break
		}
	}
	if event != VADUtteranceEnd {
		t.Fatalf("expected utterance end, got %v", event)
	}
	if !seg.SpeechEndAt().Equal(speechEnd) {
		t.Fatalf("speech end anchor = %v, want %v", seg.SpeechEndAt(), speechEnd)
	}
	if got := now.Sub(seg.SpeechEndAt()); got != 30*time.Millisecond {
		t.Fatalf("vad finalize = %v, want 30ms", got)
	}
}

type timedSpeaker struct {
	providerMs int
	encodeMs   int
}

func (s *timedSpeaker) Speak(ctx context.Context, callID, text, voiceID, boost string) ([][]byte, error) {
	packets, _, _, err := s.SpeakTimed(ctx, callID, text, voiceID, boost)
	return packets, err
}

func (s *timedSpeaker) SpeakTimed(_ context.Context, _, _, _, _ string) ([][]byte, int, int, error) {
	return [][]byte{{0x78, 0x01}, {0x78, 0x02}}, s.providerMs, s.encodeMs, nil
}

// Gateway-owned TTS/playback timings are captured and ride along with the
// NEXT turn request — no new endpoint and no behavioural change.
func TestMediaMetricsTravelOnNextTurnRequest(t *testing.T) {
	client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{SpeechText: "helo", VoiceID: "Malay_male_1_v1", LanguageBoost: "Malay"}, nil
	}}
	p, tr := newPipeline(t, client, fastCfg())
	p.WithSynthesizer(&timedSpeaker{providerMs: 410, encodeMs: 12})
	defer p.Close("test")

	pushSpeech(p, 10)
	pushSilence(p, 5)
	waitFor(t, "first reply audio", func() bool { return tr.count() >= 2 })
	waitFor(t, "metrics recorded", func() bool { return p.LastMetrics() != nil })
	// Metrics are recorded inside the first turn; wait for its lifecycle to
	// release the turn slot before injecting an entire second utterance.
	waitFor(t, "first turn completed", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.busy })

	m := p.LastMetrics()
	if m.TTSMs != 410 || m.TTSEncodeMs != 12 {
		t.Fatalf("tts timings not captured: %+v", m)
	}
	if m.PrevSequence != 1 {
		t.Fatalf("prev sequence = %d, want 1", m.PrevSequence)
	}
	if m.SpeechEndToFirstAudioMs < 0 || m.PlaybackStartMs < 0 {
		t.Fatalf("playback anchors invalid: %+v", m)
	}

	pushSpeech(p, 10)
	pushSilence(p, 5)
	waitFor(t, "second turn request", func() bool { return len(client.seen()) >= 2 })
	second := client.seen()[1]
	if second.MediaMetrics == nil {
		t.Fatal("second turn request must carry media metrics")
	}
	if second.MediaMetrics.TTSMs != 410 || second.MediaMetrics.PrevSequence != 1 {
		t.Fatalf("previous-turn metrics not propagated: %+v", second.MediaMetrics)
	}
	if second.MediaMetrics.VADFinalizeMs < 0 {
		t.Fatalf("vad finalize must never be negative: %+v", second.MediaMetrics)
	}
	// Instrumentation must never leak content.
	if second.AudioOggBase64 == "" || second.Kind != TurnKindUtterance {
		t.Fatalf("turn payload changed shape: %+v", second)
	}
}
