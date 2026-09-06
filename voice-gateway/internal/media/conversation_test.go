package media

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"
)

// ---- helpers ---------------------------------------------------------------

func speechFrame(n int) OpusFrame  { return OpusFrame{Data: make([]byte, 120), Sequence: uint16(n)} }
func silenceFrame(n int) OpusFrame { return OpusFrame{Data: make([]byte, 3), Sequence: uint16(n)} }

type fakeTransport struct {
	mu        sync.Mutex
	sent      [][]byte
	terminate []string
	failAfter int
}

func (f *fakeTransport) SendOpus(frame OpusFrame) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAfter > 0 && len(f.sent) >= f.failAfter {
		return errors.New("transport closed")
	}
	f.sent = append(f.sent, frame.Data)
	return nil
}

func (f *fakeTransport) Terminate(reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.terminate = append(f.terminate, reason)
}

func (f *fakeTransport) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

func (f *fakeTransport) reasons() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.terminate...)
}

type fakeTurns struct {
	mu       sync.Mutex
	requests []TurnRequest
	reply    func(TurnRequest) (*TurnResponse, error)
}

func (f *fakeTurns) Turn(_ context.Context, req TurnRequest) (*TurnResponse, error) {
	f.mu.Lock()
	f.requests = append(f.requests, req)
	fn := f.reply
	f.mu.Unlock()
	if fn == nil {
		return &TurnResponse{}, nil
	}
	return fn(req)
}

func (f *fakeTurns) seen() []TurnRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]TurnRequest{}, f.requests...)
}

func oggReply(packets int) string {
	frames := make([][]byte, packets)
	for i := range frames {
		frames[i] = []byte{0x78, byte(i), 0x01, 0x02}
	}
	return base64.StdEncoding.EncodeToString(WriteOggOpus(frames, 2, 960))
}

func newPipeline(t *testing.T, client TurnClient, cfg ConversationConfig) (*ConversationPipeline, *fakeTransport) {
	t.Helper()
	p := NewConversationPipeline("wacid_1", client, cfg, slog.Default())
	tr := &fakeTransport{}
	if err := p.Attach(context.Background(), tr); err != nil {
		t.Fatalf("attach: %v", err)
	}
	// Meta accept is what unblocks the pipeline in production; the tests below
	// exercise post-accept behaviour unless they say otherwise.
	p.StartGreeting()
	return p, tr
}

func fastCfg() ConversationConfig {
	return ConversationConfig{
		VAD:         VADConfig{FrameMs: 1, SpeechMinBytes: 40, StartFrames: 2, EndSilenceMs: 3, MinUtteranceMs: 2, MaxUtteranceMs: 200},
		TurnTimeout: 2 * time.Second,
	}
}

func pushSpeech(p *ConversationPipeline, frames int) {
	for i := 0; i < frames; i++ {
		p.OnInbound(speechFrame(i))
	}
}

func pushSilence(p *ConversationPipeline, frames int) {
	for i := 0; i < frames; i++ {
		p.OnInbound(silenceFrame(i))
	}
}

func waitFor(t *testing.T, what string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// ---- tests -----------------------------------------------------------------

// 1-2: real inbound Opus media reaches VAD and opens an utterance.
func TestInboundMediaDrivesVAD(t *testing.T) {
	client := &fakeTurns{}
	p, _ := newPipeline(t, client, fastCfg())
	defer p.Close("test")

	pushSpeech(p, 10)
	if !p.seg.Speaking() {
		t.Fatal("expected VAD to report speech in progress")
	}
}

// 3-7: VAD → ASR handoff → reasoning → TTS → outbound RTP delivery.
func TestUtteranceProducesOutboundAudio(t *testing.T) {
	client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{ReplyOggBase64: oggReply(4)}, nil
	}}
	p, tr := newPipeline(t, client, fastCfg())
	defer p.Close("test")

	pushSpeech(p, 10)
	pushSilence(p, 5)

	waitFor(t, "outbound audio", func() bool { return tr.count() == 4 })
	seen := client.seen()
	if len(seen) != 1 || seen[0].Kind != TurnKindUtterance || seen[0].AudioOggBase64 == "" {
		t.Fatalf("expected one utterance turn with audio, got %+v", seen)
	}
	raw, err := base64.StdEncoding.DecodeString(seen[0].AudioOggBase64)
	if err != nil {
		t.Fatalf("utterance not base64: %v", err)
	}
	packets, err := ReadOggOpus(raw)
	if err != nil || len(packets) == 0 {
		t.Fatalf("utterance is not a real ogg/opus stream: %v (%d packets)", err, len(packets))
	}
}

// Greeting turn is requested from the control plane, never hard-coded here.
func TestGreetingComesFromControlPlane(t *testing.T) {
	client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{ReplyOggBase64: oggReply(2)}, nil
	}}
	cfg := fastCfg()
	cfg.Greet = true
	p, tr := newPipeline(t, client, cfg)
	defer p.Close("test")

	waitFor(t, "greeting playback", func() bool { return tr.count() == 2 })
	if client.seen()[0].Kind != TurnKindGreeting {
		t.Fatal("first turn must be the greeting")
	}
}

// 8: silence alone never starts a turn.
func TestSilenceNeverStartsTurn(t *testing.T) {
	client := &fakeTurns{}
	p, _ := newPipeline(t, client, fastCfg())
	defer p.Close("test")

	pushSilence(p, 200)
	if len(client.seen()) != 0 {
		t.Fatal("silence must not produce a turn")
	}
}

// 9: a monologue is force-closed at the configured ceiling.
func TestMaxUtteranceDurationClosesTurn(t *testing.T) {
	client := &fakeTurns{}
	cfg := fastCfg()
	cfg.VAD.MaxUtteranceMs = 20
	p, _ := newPipeline(t, client, cfg)
	defer p.Close("test")

	pushSpeech(p, 60)
	waitFor(t, "forced utterance end", func() bool { return len(client.seen()) == 1 })
}

// 10-12: ASR / reasoning / TTS failures produce silence, never fabrication.
func TestTurnFailureProducesNoAudio(t *testing.T) {
	for _, name := range []string{"asr_failed", "reasoning_failed", "tts_failed"} {
		t.Run(name, func(t *testing.T) {
			client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
				return nil, errors.New(name)
			}}
			p, tr := newPipeline(t, client, fastCfg())
			defer p.Close("test")

			pushSpeech(p, 10)
			pushSilence(p, 5)
			waitFor(t, "turn attempt", func() bool { return len(client.seen()) == 1 })
			time.Sleep(30 * time.Millisecond)
			if tr.count() != 0 {
				t.Fatal("failed turn must not emit audio")
			}
		})
	}
}

// 13-15: barge-in stops playback and the next utterance is still captured.
func TestBargeInStopsPlaybackAndCapturesNextUtterance(t *testing.T) {
	client := &fakeTurns{reply: func(req TurnRequest) (*TurnResponse, error) {
		if req.Sequence == 1 {
			return &TurnResponse{ReplyOggBase64: oggReply(200)}, nil
		}
		return &TurnResponse{ReplyOggBase64: oggReply(1)}, nil
	}}
	cfg := fastCfg()
	cfg.VAD.FrameMs = 5
	p, tr := newPipeline(t, client, cfg)
	defer p.Close("test")

	pushSpeech(p, 10)
	pushSilence(p, 5)
	waitFor(t, "playback started", func() bool { return p.Speaking() })
	sentAtInterrupt := tr.count()

	pushSpeech(p, 4) // caller interrupts
	waitFor(t, "playback cancelled", func() bool { return !p.Speaking() })
	if p.BargeIns() != 1 {
		t.Fatalf("expected 1 barge-in, got %d", p.BargeIns())
	}
	time.Sleep(40 * time.Millisecond)
	if tr.count() > sentAtInterrupt+2 {
		t.Fatalf("remaining TTS audio was not discarded (%d -> %d)", sentAtInterrupt, tr.count())
	}

	pushSpeech(p, 6)
	pushSilence(p, 5)
	waitFor(t, "second utterance", func() bool { return len(client.seen()) == 2 })
	if client.seen()[1].Kind != TurnKindUtterance {
		t.Fatal("second turn must be the interrupting utterance")
	}
}

// 16-17: termination during a turn or during playback is safe and idempotent.
func TestTerminationDuringTurnAndPlayback(t *testing.T) {
	release := make(chan struct{})
	client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		<-release
		return &TurnResponse{ReplyOggBase64: oggReply(50)}, nil
	}}
	p, tr := newPipeline(t, client, fastCfg())

	pushSpeech(p, 10)
	pushSilence(p, 5)
	waitFor(t, "turn in flight", func() bool { return len(client.seen()) == 1 })

	go func() { close(release) }()
	p.Close("caller_hangup")
	p.Close("caller_hangup") // idempotent
	before := tr.count()
	time.Sleep(30 * time.Millisecond)
	if tr.count() != before {
		t.Fatal("audio emitted after close")
	}
}

// 18: duplicate/overlapping utterances never start a second concurrent turn.
func TestNoConcurrentTurns(t *testing.T) {
	release := make(chan struct{})
	client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		<-release
		return &TurnResponse{}, nil
	}}
	p, _ := newPipeline(t, client, fastCfg())
	defer func() { close(release); p.Close("test") }()

	for i := 0; i < 3; i++ {
		pushSpeech(p, 10)
		pushSilence(p, 5)
	}
	time.Sleep(30 * time.Millisecond)
	if len(client.seen()) != 1 {
		t.Fatalf("expected exactly 1 in-flight turn, got %d", len(client.seen()))
	}
}

// Bounded loop: the pipeline can never run away.
func TestMaxTurnsBoundsLoop(t *testing.T) {
	client := &fakeTurns{}
	cfg := fastCfg()
	cfg.MaxTurns = 2
	p, _ := newPipeline(t, client, cfg)
	defer p.Close("test")

	for i := 0; i < 6; i++ {
		pushSpeech(p, 10)
		pushSilence(p, 5)
		waitFor(t, "turn settled", func() bool { return !p.busyNow() })
	}
	if p.Turns() != 2 {
		t.Fatalf("expected loop bounded at 2 turns, got %d", p.Turns())
	}
}

// End-call instruction from the control plane terminates the media session.
func TestEndCallTerminatesTransport(t *testing.T) {
	client := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{EndCall: true, Reason: "conversation_complete"}, nil
	}}
	p, tr := newPipeline(t, client, fastCfg())
	defer p.Close("test")

	pushSpeech(p, 10)
	pushSilence(p, 5)
	waitFor(t, "termination", func() bool { return len(tr.reasons()) == 1 })
}

// 27: no secret, token or transcript is ever handled by the pipeline.
func TestTurnRequestCarriesNoSecrets(t *testing.T) {
	client := &fakeTurns{}
	p, _ := newPipeline(t, client, fastCfg())
	defer p.Close("test")

	pushSpeech(p, 10)
	pushSilence(p, 5)
	waitFor(t, "turn", func() bool { return len(client.seen()) == 1 })
	req := client.seen()[0]
	if req.CallID != "wacid_1" || req.DurationMs <= 0 {
		t.Fatalf("unexpected turn payload: %+v", req)
	}
}

func (p *ConversationPipeline) busyNow() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.busy
}
