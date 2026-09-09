package media

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"
)

type candidateTransport struct {
	fakeTransport
	connected atomic.Bool
	pipeline  *ConversationPipeline
	ended     chan struct{}
}

func (t *candidateTransport) ConnectionState() pion.PeerConnectionState {
	if t.connected.Load() {
		return pion.PeerConnectionStateConnected
	}
	return pion.PeerConnectionStateConnecting
}
func (t *candidateTransport) Terminate(reason string) {
	t.fakeTransport.Terminate(reason)
	if t.pipeline != nil {
		t.pipeline.Close(reason)
	}
	if t.ended != nil {
		close(t.ended)
	}
}

func TestConversationCandidateGreetingWaitsForTransportWithoutInbound(t *testing.T) {
	for _, connectFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "accept_first", true: "connected_first"}[connectFirst], func(t *testing.T) {
			turns := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) { return &TurnResponse{ReplyOggBase64: oggReply(3)}, nil }}
			p := NewConversationPipeline("candidate-greeting", turns, greetCfg(), nil)
			tr := &candidateTransport{}
			tr.connected.Store(connectFirst)
			if err := p.Attach(context.Background(), tr); err != nil {
				t.Fatal(err)
			}
			defer p.Close("test")
			time.Sleep(25 * time.Millisecond)
			if len(turns.seen()) != 0 {
				t.Fatal("greeting before accept")
			}
			p.StartGreeting()
			if !connectFirst {
				time.Sleep(30 * time.Millisecond)
				if len(turns.seen()) != 0 || tr.count() != 0 {
					t.Fatal("greeting consumed before transport ready")
				}
				tr.connected.Store(true)
			}
			waitFor(t, "system-first greeting with no inbound audio", func() bool { return tr.count() == 3 })
			if len(turns.seen()) != 1 {
				t.Fatal("greeting must occur exactly once")
			}
			if p.StartGreeting() != GreetingDuplicate {
				t.Fatal("duplicate greeting")
			}
		})
	}
}

func TestConversationCandidateFarewellFinishesAndSelfCloseDoesNotDeadlock(t *testing.T) {
	turns := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{ReplyOggBase64: oggReply(8), EndCall: true}, nil
	}}
	p := NewConversationPipeline("candidate-close", turns, fastCfg(), nil)
	tr := &candidateTransport{pipeline: p, ended: make(chan struct{})}
	tr.connected.Store(true)
	if err := p.Attach(context.Background(), tr); err != nil {
		t.Fatal(err)
	}
	p.StartGreeting()
	pushSpeech(p, 6)
	pushSilence(p, 8)
	select {
	case <-tr.ended:
	case <-time.After(time.Second):
		t.Fatal("teardown waited on its own turn")
	}
	if tr.count() != 8 || len(tr.reasons()) != 1 {
		t.Fatal("farewell clipped or termination duplicated")
	}
}

func TestConversationCandidateInterruptedFarewellDoesNotHangUp(t *testing.T) {
	turns := &fakeTurns{reply: func(req TurnRequest) (*TurnResponse, error) {
		if req.Sequence == 1 {
			return &TurnResponse{ReplyOggBase64: oggReply(200), EndCall: true}, nil
		}
		return &TurnResponse{}, nil
	}}
	p, tr := newPipeline(t, turns, fastCfg())
	defer p.Close("test")
	pushSpeech(p, 6)
	pushSilence(p, 8)
	waitFor(t, "farewell starts", func() bool { return tr.count() > 0 })
	pushSpeech(p, 6)
	pushSilence(p, 8)
	waitFor(t, "caller continuation retained", func() bool { return len(turns.seen()) == 2 })
	if len(tr.reasons()) != 0 {
		t.Fatal("hung up during caller continuation")
	}
}

func TestConversationCandidateNoPlaybackOverCallerAndNoLostCompletedTurn(t *testing.T) {
	release := make(chan struct{})
	turns := &fakeTurns{reply: func(req TurnRequest) (*TurnResponse, error) {
		if req.Sequence == 1 {
			<-release
			return &TurnResponse{ReplyOggBase64: oggReply(10)}, nil
		}
		return &TurnResponse{ReplyOggBase64: oggReply(2)}, nil
	}}
	p, tr := newPipeline(t, turns, fastCfg())
	defer p.Close("test")
	pushSpeech(p, 6)
	pushSilence(p, 8)
	waitFor(t, "first reasoning", func() bool { return len(turns.seen()) == 1 })
	pushSpeech(p, 6)
	close(release)
	waitFor(t, "stale turn cancels", func() bool { return !p.busyNow() })
	if tr.count() != 0 {
		t.Fatal("interrupted caller with stale answer")
	}
	pushSilence(p, 8)
	waitFor(t, "second turn speaks", func() bool { return tr.count() == 2 })
	if len(turns.seen()) != 2 {
		t.Fatal("caller speech was discarded")
	}
}

type candidateStream struct {
	final chan struct{}
	ack   chan struct{}
}

func (c *candidateStream) Turn(context.Context, TurnRequest) (*TurnResponse, error) {
	panic("stream was not used")
}
func (c *candidateStream) TurnStream(ctx context.Context, req TurnRequest, onAck func(TurnResponse)) (*TurnResponse, error) {
	onAck(TurnResponse{SpeechText: "Baik, sekejap ya.", VoiceID: "Malay_male_1_v1", LanguageBoost: "Malay"})
	close(c.ack)
	select {
	case <-c.final:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return &TurnResponse{ReplyOggBase64: oggReply(4)}, nil
}

type candidateSynth struct{}

func (candidateSynth) Speak(context.Context, string, string, string, string) ([][]byte, error) {
	return [][]byte{{0x78, 1}, {0x78, 2}}, nil
}

func TestConversationCandidateCachedAckPlaysWhileReasoningPending(t *testing.T) {
	client := &candidateStream{final: make(chan struct{}), ack: make(chan struct{})}
	p, tr := newPipeline(t, client, fastCfg())
	p.WithSynthesizer(candidateSynth{})
	defer p.Close("test")
	p.mu.Lock()
	p.ackCache = map[string][][]byte{ackKey(TurnResponse{SpeechText: "Baik, sekejap ya.", VoiceID: "Malay_male_1_v1", LanguageBoost: "Malay"}): {{0x78, 1}, {0x78, 2}}}
	p.mu.Unlock()
	pushSpeech(p, 6)
	pushSilence(p, 8)
	<-client.ack
	waitFor(t, "ack before final reasoning", func() bool { return tr.count() == 2 })
	if !p.busyNow() {
		t.Fatal("substantive reasoning should still be pending")
	}
	close(client.final)
	waitFor(t, "substantive audio after acknowledgement", func() bool { return tr.count() == 6 })
}

func TestConversationCandidateThreeTurnsThenNaturalClose(t *testing.T) {
	turns := &fakeTurns{reply: func(req TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{ReplyOggBase64: oggReply(3), EndCall: req.Sequence == 4}, nil
	}}
	p := NewConversationPipeline("candidate-three-turns", turns, fastCfg(), nil)
	tr := &candidateTransport{pipeline: p, ended: make(chan struct{})}
	tr.connected.Store(true)
	if err := p.Attach(context.Background(), tr); err != nil {
		t.Fatal(err)
	}
	defer p.Close("test")
	p.StartGreeting()
	for turn := 1; turn <= 3; turn++ {
		pushSpeech(p, 6)
		pushSilence(p, 8)
		waitFor(t, "complete conversational reply", func() bool { return tr.count() == turn*3 && !p.busyNow() })
		if len(tr.reasons()) != 0 {
			t.Fatal("terminated an active conversation")
		}
	}
	pushSpeech(p, 6)
	pushSilence(p, 8)
	select {
	case <-tr.ended:
	case <-time.After(time.Second):
		t.Fatal("natural termination missing")
	}
	if tr.count() != 12 || len(tr.reasons()) != 1 {
		t.Fatal("incomplete farewell or duplicate termination")
	}
}

func TestConversationCandidateMaxClosureKeepsCallerOwnership(t *testing.T) {
	turns := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{ReplyOggBase64: oggReply(3)}, nil
	}}
	cfg := fastCfg()
	cfg.VAD.MaxUtteranceMs = 20
	p, tr := newPipeline(t, turns, cfg)
	defer p.Close("test")
	pushSpeech(p, 20)
	waitFor(t, "bounded turn dispatched before caller silence", func() bool { return len(turns.seen()) > 0 })
	time.Sleep(15 * time.Millisecond) // give the ready reply time to attempt playback
	if tr.count() != 0 {
		t.Fatal("a forced size boundary interrupted the caller")
	}
	pushSpeech(p, 40)
	time.Sleep(15 * time.Millisecond)
	if got := len(turns.seen()); got != 1 {
		t.Fatalf("continuous speech dispatched %d turns before end-of-speech, want 1", got)
	}
	if tr.count() != 0 {
		t.Fatal("queued continuation interrupted caller")
	}
	pushSilence(p, cfg.VAD.EndSilenceMs/cfg.VAD.FrameMs)
	waitFor(t, "retained chunks drain after genuine end-of-speech", func() bool { return len(turns.seen()) == 3 && !p.busyNow() })
	if tr.count() == 0 {
		t.Fatal("no response after caller stopped")
	}
	for _, req := range turns.seen() {
		if req.DurationMs != 20 {
			t.Fatalf("forced closure duration = %d, want 20", req.DurationMs)
		}
	}
}
