package media

import (
	"context"
	"testing"
	"time"
)

func completionPipeline(t *testing.T) (*ConversationPipeline, *fakeTurns, *fakeTransport) {
	t.Helper()
	client := &fakeTurns{reply: func(req TurnRequest) (*TurnResponse, error) {
		if req.Kind == TurnKindSilence {
			return &TurnResponse{ReplyOggBase64: oggReply(2), EndCall: true, Reason: "conversation_complete"}, nil
		}
		return &TurnResponse{ReplyOggBase64: oggReply(2), AwaitingCompletion: true}, nil
	}}
	cfg := fastCfg()
	cfg.CompletionSilence = 40 * time.Millisecond
	p, tr := newPipeline(t, client, cfg)
	t.Cleanup(func() { p.Close("test") })
	return p, client, tr
}

type completionSpeaker struct {
	started chan struct{}
	release chan struct{}
}

func (s *completionSpeaker) Speak(context.Context, string, string, string, string) ([][]byte, error) {
	close(s.started)
	<-s.release
	return [][]byte{{0x78, 0x01}}, nil
}

func TestCallerResumingDuringFarewellSynthesisPreventsPlayback(t *testing.T) {
	speaker := &completionSpeaker{started: make(chan struct{}), release: make(chan struct{})}
	client := &fakeTurns{reply: func(req TurnRequest) (*TurnResponse, error) {
		if req.Kind == TurnKindSilence {
			return &TurnResponse{SpeechText: "Goodbye", EndCall: true}, nil
		}
		return &TurnResponse{ReplyOggBase64: oggReply(2), AwaitingCompletion: true}, nil
	}}
	cfg := fastCfg()
	cfg.CompletionSilence = 20 * time.Millisecond
	p, tr := newPipeline(t, client, cfg)
	p.WithSynthesizer(speaker)
	defer p.Close("test")
	pushSpeech(p, 6)
	pushSilence(p, 8)
	select {
	case <-speaker.started:
	case <-time.After(time.Second):
		close(speaker.release)
		t.Fatal("farewell synthesis not started")
	}
	pushSpeech(p, 6)
	close(speaker.release)
	waitFor(t, "silence turn released", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.busy })
	if len(tr.reasons()) != 0 || tr.count() != 2 {
		t.Fatal("stale synthesized farewell interrupted the resumed caller")
	}
}

func TestCompletionSilencePlaysFarewellThenTerminates(t *testing.T) {
	p, client, tr := completionPipeline(t)
	pushSpeech(p, 6)
	pushSilence(p, 8)
	waitFor(t, "automatic farewell termination", func() bool { return len(tr.reasons()) == 1 })
	requests := client.seen()
	if len(requests) != 2 || requests[1].Kind != TurnKindSilence || requests[1].AudioOggBase64 != "" {
		t.Fatalf("expected one audio-free silence event after completion question, got %+v", requests)
	}
	if tr.count() != 4 || tr.reasons()[0] != "conversation_complete" {
		t.Fatalf("farewell playback did not precede termination: frames=%d reasons=%v", tr.count(), tr.reasons())
	}
}

func TestCallerSpeechCancelsCompletionSilence(t *testing.T) {
	p, client, tr := completionPipeline(t)
	pushSpeech(p, 6)
	pushSilence(p, 8)
	waitFor(t, "completion timer", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.completionTimer != nil && !p.busy })
	pushSpeech(p, 6)
	time.Sleep(80 * time.Millisecond)
	if len(client.seen()) != 1 || len(tr.reasons()) != 0 {
		t.Fatal("temporary silence timer ended a caller who resumed speaking")
	}
}

func TestCloseCancelsCompletionTimer(t *testing.T) {
	p, client, _ := completionPipeline(t)
	pushSpeech(p, 6)
	pushSilence(p, 8)
	waitFor(t, "completion timer", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.completionTimer != nil })
	p.Close("caller_terminated")
	time.Sleep(80 * time.Millisecond)
	if len(client.seen()) != 1 {
		t.Fatal("completion callback ran after close")
	}
}

func TestFailedPlaybackDoesNotArmCompletionTimer(t *testing.T) {
	p, client, tr := completionPipeline(t)
	tr.failAfter = 1
	pushSpeech(p, 6)
	pushSilence(p, 8)
	waitFor(t, "partial audio", func() bool { return tr.count() == 1 })
	time.Sleep(80 * time.Millisecond)
	if len(client.seen()) != 1 || len(tr.reasons()) != 0 {
		t.Fatal("incomplete completion question armed a farewell")
	}
}

func TestCallerResumingDuringSilenceRequestPreventsFarewell(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	client := &fakeTurns{reply: func(req TurnRequest) (*TurnResponse, error) {
		if req.Kind == TurnKindSilence {
			close(started)
			<-release
			return &TurnResponse{ReplyOggBase64: oggReply(2), EndCall: true}, nil
		}
		return &TurnResponse{ReplyOggBase64: oggReply(2), AwaitingCompletion: true}, nil
	}}
	cfg := fastCfg()
	cfg.CompletionSilence = 20 * time.Millisecond
	p, tr := newPipeline(t, client, cfg)
	defer p.Close("test")
	pushSpeech(p, 6)
	pushSilence(p, 8)
	select {
	case <-started:
	case <-time.After(time.Second):
		close(release)
		t.Fatal("silence turn not started")
	}
	pushSpeech(p, 6)
	close(release)
	waitFor(t, "silence turn released", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.busy })
	if len(tr.reasons()) != 0 || tr.count() != 2 {
		t.Fatal("stale silence interrupted the resumed caller")
	}
}
