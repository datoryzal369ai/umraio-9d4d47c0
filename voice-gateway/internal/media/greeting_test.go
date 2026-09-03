package media

import (
	"context"
	"log/slog"
	"testing"
	"time"
)

// The production deadlock these tests lock down: the greeting used to start at
// Attach time, i.e. before Meta `accept` completed. The control plane rejects
// such a turn (`not_accepted`) and never retries it, so nothing ever produced
// the first outbound RTP packet and media_ready never fired.

func attachedPipeline(t *testing.T, cfg ConversationConfig) (*ConversationPipeline, *fakeTurns, *fakeTransport) {
	t.Helper()
	turns := &fakeTurns{reply: func(TurnRequest) (*TurnResponse, error) {
		return &TurnResponse{AudioBase64: oggReply(3), Format: "ogg_opus"}, nil
	}}
	p := NewConversationPipeline("wacid_greet", turns, cfg, slog.Default())
	tr := &fakeTransport{}
	if err := p.Attach(context.Background(), tr); err != nil {
		t.Fatalf("attach: %v", err)
	}
	return p, turns, tr
}

func greetCfg() ConversationConfig {
	c := fastCfg()
	c.Greet = true
	return c
}

func TestNoGreetingBeforeAcceptCompletes(t *testing.T) {
	p, turns, tr := attachedPipeline(t, greetCfg())
	defer p.Close("test")

	time.Sleep(50 * time.Millisecond)
	if got := len(turns.seen()); got != 0 {
		t.Fatalf("expected no turn before accept, got %d", got)
	}
	if tr.count() != 0 {
		t.Fatalf("expected no outbound audio before accept, got %d frames", tr.count())
	}
	if p.Greeted() {
		t.Fatal("pipeline reported a greeting before accept")
	}
}

func TestExactlyOneGreetingAfterAccept(t *testing.T) {
	p, turns, tr := attachedPipeline(t, greetCfg())
	defer p.Close("test")

	if out := p.StartGreeting(); out != GreetingStarted {
		t.Fatalf("first accept notification: got %q want %q", out, GreetingStarted)
	}
	for _, out := range []GreetingOutcome{p.StartGreeting(), p.StartGreeting()} {
		if out != GreetingDuplicate {
			t.Fatalf("repeat accept notification: got %q want %q", out, GreetingDuplicate)
		}
	}

	waitFor(t, "greeting playback", func() bool { return tr.count() > 0 })

	greetings := 0
	for _, req := range turns.seen() {
		if req.Kind == TurnKindGreeting {
			greetings++
		}
	}
	if greetings != 1 {
		t.Fatalf("expected exactly 1 greeting turn, got %d", greetings)
	}
}

func TestNoGreetingAfterTerminate(t *testing.T) {
	p, turns, tr := attachedPipeline(t, greetCfg())

	p.Close("caller_terminated")
	if out := p.StartGreeting(); out != GreetingClosed {
		t.Fatalf("post-terminate notification: got %q want %q", out, GreetingClosed)
	}
	time.Sleep(50 * time.Millisecond)
	if len(turns.seen()) != 0 || tr.count() != 0 {
		t.Fatalf("greeting ran after terminate: turns=%d frames=%d", len(turns.seen()), tr.count())
	}
}

func TestCallerUtteranceIgnoredUntilAccept(t *testing.T) {
	p, turns, _ := attachedPipeline(t, fastCfg())
	defer p.Close("test")

	pushSpeech(p, 6)
	pushSilence(p, 8)
	time.Sleep(50 * time.Millisecond)
	if got := len(turns.seen()); got != 0 {
		t.Fatalf("expected no turn before accept, got %d", got)
	}

	p.StartGreeting() // accept signal; greeting disabled in this config
	pushSpeech(p, 6)
	pushSilence(p, 8)
	waitFor(t, "post-accept turn", func() bool { return len(turns.seen()) > 0 })
}

func TestGreetingDisabledStillRecordsAccept(t *testing.T) {
	p, _, _ := attachedPipeline(t, fastCfg())
	defer p.Close("test")

	if out := p.StartGreeting(); out != GreetingDisabled {
		t.Fatalf("got %q want %q", out, GreetingDisabled)
	}
	if p.Greeted() {
		t.Fatal("no greeting should have been started")
	}
}
