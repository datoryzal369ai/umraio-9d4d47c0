package session

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func newSess() *Session { return New("ms_1", "call-1", "ag_1", "pn_1", time.Now()) }

func TestStateProgressesForward(t *testing.T) {
	s := newSess()
	for _, st := range []State{StateConnecting, StateMediaNegotiating, StateMediaReady, StateActive} {
		if err := s.Advance(st, "", time.Now()); err != nil {
			t.Fatalf("advance to %s: %v", st, err)
		}
	}
	if s.State() != StateActive {
		t.Fatalf("expected ACTIVE, got %s", s.State())
	}
}

func TestStateRegressionRejected(t *testing.T) {
	s := newSess()
	_ = s.Advance(StateConnecting, "", time.Now())
	_ = s.Advance(StateActive, "", time.Now())
	if err := s.Advance(StateMediaNegotiating, "", time.Now()); !errors.Is(err, ErrStateRegression) {
		t.Fatalf("expected ErrStateRegression, got %v", err)
	}
	if s.State() != StateActive {
		t.Fatalf("state mutated on rejected transition: %s", s.State())
	}
}

func TestTerminalStatesAbsorb(t *testing.T) {
	s := newSess()
	_ = s.Advance(StateTerminated, "caller_hangup", time.Now())
	if err := s.Advance(StateActive, "", time.Now()); !errors.Is(err, ErrTerminal) {
		t.Fatalf("expected ErrTerminal, got %v", err)
	}
	if s.State() != StateTerminated || s.TerminationReason() != "caller_hangup" {
		t.Fatalf("terminal state not preserved: %+v", s.Stats())
	}
}

func TestUnknownStateRejected(t *testing.T) {
	if err := newSess().Advance(State("BOGUS"), "", time.Now()); !errors.Is(err, ErrUnknownState) {
		t.Fatalf("expected ErrUnknownState, got %v", err)
	}
}

func TestMediaReadyRequiresRealInboundMedia(t *testing.T) {
	s := newSess()
	_ = s.Advance(StateConnecting, "", time.Now())
	_ = s.Advance(StateMediaNegotiating, "", time.Now())

	// SDP exchanged + peer connection created is NOT enough.
	if s.MediaReadyRule() {
		t.Fatal("media ready must not hold before ICE/RTP")
	}
	s.MarkICEConnected(time.Now())
	s.MarkOutboundReady()
	if s.MediaReadyRule() {
		t.Fatal("media ready must not hold on ICE alone")
	}
	s.RecordInbound(time.Now())
	if !s.MediaReadyRule() {
		t.Fatal("media ready should hold once real inbound RTP arrives")
	}
}

func TestMediaReadyFiresExactlyOnce(t *testing.T) {
	s := newSess()
	s.MarkICEConnected(time.Now())
	s.MarkOutboundReady()
	s.RecordInbound(time.Now())
	if !s.TryFireMediaReady(time.Now()) {
		t.Fatal("first fire expected")
	}
	if s.TryFireMediaReady(time.Now()) {
		t.Fatal("media_ready must fire only once")
	}
}

func TestMediaReadyNeverFiresAfterTermination(t *testing.T) {
	s := newSess()
	s.MarkICEConnected(time.Now())
	s.MarkOutboundReady()
	_ = s.Advance(StateFailed, "ice_failed", time.Now())
	s.RecordInbound(time.Now())
	if s.TryFireMediaReady(time.Now()) {
		t.Fatal("terminated session must never report media_ready")
	}
}

func TestConcurrentStateAccessIsSafe(t *testing.T) {
	s := newSess()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(3)
		go func() { defer wg.Done(); s.RecordInbound(time.Now()) }()
		go func() { defer wg.Done(); _ = s.Advance(StateConnecting, "", time.Now()) }()
		go func() { defer wg.Done(); _ = s.Stats() }()
	}
	wg.Wait()
	if s.Stats().InboundPackets != 50 {
		t.Fatalf("lost packet counts: %d", s.Stats().InboundPackets)
	}
}

func TestRegistryEnforcesConcurrencyCeiling(t *testing.T) {
	r := NewRegistry(2)
	for i, id := range []string{"a", "b"} {
		if err := r.Add(New("ms_"+id, "call-"+id, "ag", "pn", time.Now())); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	if err := r.Add(New("ms_c", "call-c", "ag", "pn", time.Now())); !errors.Is(err, ErrCapacity) {
		t.Fatalf("expected ErrCapacity, got %v", err)
	}
	r.Remove("call-a")
	if err := r.Add(New("ms_c", "call-c", "ag", "pn", time.Now())); err != nil {
		t.Fatalf("slot should free after removal: %v", err)
	}
}

func TestRegistryRejectsDuplicateCall(t *testing.T) {
	r := NewRegistry(5)
	_ = r.Add(New("ms_1", "call-1", "ag", "pn", time.Now()))
	if err := r.Add(New("ms_2", "call-1", "ag", "pn", time.Now())); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("expected ErrDuplicate, got %v", err)
	}
}

func TestRegistryRateLimitPerSession(t *testing.T) {
	r := NewRegistry(5)
	now := time.Now()
	for i := 0; i < 30; i++ {
		if err := r.Allow("call-1", now); err != nil {
			t.Fatalf("op %d rejected early: %v", i, err)
		}
	}
	if err := r.Allow("call-1", now); !errors.Is(err, ErrRateLimit) {
		t.Fatalf("expected ErrRateLimit, got %v", err)
	}
	if err := r.Allow("call-1", now.Add(2*time.Minute)); err != nil {
		t.Fatalf("window should slide: %v", err)
	}
}

func TestRegistryExpiryDetectsTimeouts(t *testing.T) {
	r := NewRegistry(5)
	start := time.Now()
	s := New("ms_1", "call-1", "ag", "pn", start)
	_ = r.Add(s)
	if got := r.Expired(start.Add(5*time.Second), 10*time.Minute, 30*time.Second); len(got) != 0 {
		t.Fatalf("nothing should be expired yet, got %d", len(got))
	}
	if got := r.Expired(start.Add(45*time.Second), 10*time.Minute, 30*time.Second); len(got) != 1 {
		t.Fatalf("negotiation timeout not detected, got %d", len(got))
	}
	if got := r.Expired(start.Add(11*time.Minute), 10*time.Minute, 30*time.Second); len(got) != 1 {
		t.Fatalf("max duration not detected, got %d", len(got))
	}
}
