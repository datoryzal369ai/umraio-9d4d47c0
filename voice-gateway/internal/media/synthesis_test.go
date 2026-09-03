package media

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
)

type fakeSynth struct {
	mu       sync.Mutex
	calls    []string
	voices   []string
	boosts   []string
	packets  int
	failWith error
}

func (f *fakeSynth) Speak(_ context.Context, _, text, voice, boost string) ([][]byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, text)
	f.voices = append(f.voices, voice)
	f.boosts = append(f.boosts, boost)
	fail, n := f.failWith, f.packets
	f.mu.Unlock()
	if fail != nil {
		return nil, fail
	}
	out := make([][]byte, n)
	for i := range out {
		out[i] = []byte{0x78, byte(i)}
	}
	return out, nil
}

func (f *fakeSynth) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.calls...)
}

func newSynthPipeline(t *testing.T, client TurnClient, synth Synthesizer) (*ConversationPipeline, *fakeTransport) {
	t.Helper()
	cfg := fastCfg()
	cfg.Greet = true
	p := NewConversationPipeline("wacid_tts", client, cfg, slog.Default()).WithSynthesizer(synth)
	tr := &fakeTransport{}
	if err := p.Attach(context.Background(), tr); err != nil {
		t.Fatalf("attach: %v", err)
	}
	p.StartGreeting()
	return p, tr
}

// The control plane sends TEXT; the media plane speaks it with the locked voice.
func TestSpeechTextIsSynthesizedAndSent(t *testing.T) {
	client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{
			SpeechText:    "Assalamualaikum, saya RAIO.",
			VoiceID:       "Malay_male_1_v1",
			LanguageBoost: "Malay",
		}, nil
	}}
	synth := &fakeSynth{packets: 5}
	p, tr := newSynthPipeline(t, client, synth)
	defer p.Close("test")

	waitFor(t, "synthesized greeting playback", func() bool { return tr.count() == 5 })
	if got := synth.seen(); len(got) == 0 || got[0] != "Assalamualaikum, saya RAIO." {
		t.Fatalf("unexpected synthesis input: %v", got)
	}
	if synth.voices[0] != "Malay_male_1_v1" || synth.boosts[0] != "Malay" {
		t.Fatalf("voice identity not forwarded: %v %v", synth.voices, synth.boosts)
	}
}

// FAIL CLOSED: a synthesis failure is silence, never substitute audio.
func TestSynthesisFailureProducesSilenceNotSubstitute(t *testing.T) {
	client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{SpeechText: "hello"}, nil
	}}
	synth := &fakeSynth{failWith: errors.New("provider")}
	p, tr := newSynthPipeline(t, client, synth)
	defer p.Close("test")

	waitFor(t, "synthesis attempt", func() bool { return len(synth.seen()) == 1 })
	if tr.count() != 0 {
		t.Fatalf("expected no audio, sent %d frames", tr.count())
	}
}

// A gateway without a synthesizer must not crash and must not fabricate audio.
func TestSpeechTextWithoutSynthesizerIsSilent(t *testing.T) {
	client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{SpeechText: "hello"}, nil
	}}
	cfg := fastCfg()
	cfg.Greet = true
	p, tr := newPipeline(t, client, cfg)
	defer p.Close("test")

	waitFor(t, "turn request", func() bool { return len(client.seen()) >= 1 })
	if tr.count() != 0 {
		t.Fatalf("expected silence, sent %d frames", tr.count())
	}
}

// Legacy pre-rendered OGG still plays when no speech text is supplied.
func TestPreRenderedOggStillSupported(t *testing.T) {
	client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{ReplyOggBase64: oggReply(3)}, nil
	}}
	synth := &fakeSynth{packets: 9}
	p, tr := newSynthPipeline(t, client, synth)
	defer p.Close("test")

	waitFor(t, "ogg playback", func() bool { return tr.count() == 3 })
	if len(synth.seen()) != 0 {
		t.Fatalf("synthesizer must not run when audio is provided")
	}
}
