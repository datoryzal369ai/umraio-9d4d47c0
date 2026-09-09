package webrtc

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	pion "github.com/pion/webrtc/v4"
	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/session"
)

type forbiddenFormatter struct{}

func (forbiddenFormatter) String() string { panic("raw Pion argument must never be formatted") }
func TestICETraceSanitizationAndTransactionEvidence(t *testing.T) {
	buf := &diagnosticLogBuffer{}
	f := newICELogFactory(slog.New(slog.NewJSONHandler(buf, nil)))
	l := f.NewLogger("ice")
	l.Debugf("Started agent: isControlling? %t, remoteUfrag: %q, remotePwd: %q", true, "secret_ufrag", forbiddenFormatter{})
	l.Tracef("unknown message %s", forbiddenFormatter{})
	c, err := ice.NewCandidateHost(&ice.CandidateHostConfig{Network: "udp", Address: "203.0.113.20", Port: 40000, Component: 1, Foundation: "123"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := ice.NewCandidateHost(&ice.CandidateHostConfig{Network: "udp", Address: "2001:db8::1", Port: 443, Component: 1, Foundation: "private_content"})
	if err != nil {
		t.Fatal(err)
	}
	l.Tracef("Ping STUN from %s to %s", c, r)
	l.Tracef("Discarded %d binding requests because they expired", 3)
	l.Tracef("Failed to send STUN message: %s", &net.OpError{Op: "write", Net: "udp", Err: syscall.ENETUNREACH})
	l.Warnf("Discard request with wrong username from (%s), %v", forbiddenFormatter{}, errors.New("provider_key_secret"))
	out := buf.String()
	for _, s := range []string{"secret_ufrag", "private_content", "203.0.113.20", "2001:db8::1", "provider_key_secret", c.ID(), r.ID()} {
		if strings.Contains(out, s) {
			t.Fatalf("sensitive value leaked: %q", s)
		}
	}
	events := findEvents(buf, "ice check trace")
	if len(events) != 5 {
		t.Fatalf("events=%d, want 5", len(events))
	}
	if events[0]["ice_role"] != "controlling" || events[1]["local_candidate"] != diagnosticCandidateID(c.ID()) || events[1]["remote_family"] != "ipv6" || events[1]["local_port"] != float64(40000) {
		t.Fatal("missing sanitized candidate/role evidence")
	}
	if events[2]["expired_total"] != float64(3) || events[3]["error_class"] != "network_unreachable" || events[4]["event"] != "stun_username_rejected" {
		t.Fatal("missing transaction outcomes")
	}
}
func TestICETraceConcurrentCounters(t *testing.T) {
	buf := &diagnosticLogBuffer{}
	l := newICELogFactory(slog.New(slog.NewJSONHandler(buf, nil))).NewLogger("ice")
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				l.Tracef("Discarded %d binding requests because they expired", 1)
				_ = buf.String()
			}
		}()
	}
	wg.Wait()
	var max float64
	for _, e := range findEvents(buf, "ice check trace") {
		if n := e["expired_total"].(float64); n > max {
			max = n
		}
	}
	if max != 100 {
		t.Fatalf("expired total=%v", max)
	}
}
func TestICEDiagnosticsCaptureCheckingBeforeTeardown(t *testing.T) {
	buf := &diagnosticLogBuffer{}
	e, err := NewEngine(Config{Logger: slog.New(slog.NewJSONHandler(buf, nil))})
	if err != nil {
		t.Fatal(err)
	}
	caller, _ := newLoopbackCaller(t)
	defer caller.Close()
	s := session.New("diagnostic-failed", "synthetic-call", "a", "p", time.Now())
	_, ms, err := e.Establish(context.Background(), s, callerOffer(t, caller), nil, Hooks{})
	if err != nil {
		t.Fatal(err)
	}
	defer ms.Terminate("test_done")
	// Withhold the answer from the synthetic caller: checks receive no valid
	// responses. This exercises the real agent, not fabricated stats.
	deadline := time.Now().Add(4 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		ms.diagnostics.snapshot("test", false)
		for _, r := range findEvents(buf, "ice candidate pair observed") {
			if r["check_requests_attempted"].(float64) > 0 {
				found = true
			}
		}
		if found {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !found {
		t.Fatal("no real connectivity check captured")
	}
	if err := ms.SendOpus(umedia.OpusFrame{Data: silentOpusFrame, Duration: 20 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	if len(findEvents(buf, "first outbound opus on ready transport")) != 0 {
		t.Fatal("unbound local write incorrectly reported transport-ready")
	}
	ms.Terminate("caller_terminated")
	snapshots := findEvents(buf, "ice session snapshot")
	last := snapshots[len(snapshots)-1]
	if last["trigger"] != "before_teardown" || last["media_ready"] != false || last["inbound_rtp_packets"] != float64(0) || last["peer_state"] == "closed" {
		t.Fatalf("lost pre-teardown state: %+v", last)
	}
	pairs := findEvents(buf, "ice candidate pair observed")
	final := pairs[len(pairs)-1]
	if final["trigger"] != "before_teardown" || final["check_requests_attempted"].(float64) < 1 || final["check_responses_received"] != float64(0) || final["retransmits_available"] != false {
		t.Fatalf("bad failed pair counters: %+v", final)
	}
	if len(findEvents(buf, "ice candidate observed")) < 2 {
		t.Fatal("local/remote candidates missing")
	}
	// Correlate the real trace to this exact session using its opaque candidate ID.
	matched := false
	for _, r := range findEvents(buf, "ice check trace") {
		if r["event"] == "check_request_attempt" && r["local_candidate"] == final["local_candidate"] {
			matched = true
		}
	}
	if !matched {
		t.Fatal("STUN trace cannot be joined to session candidate")
	}
}
func TestICEDiagnosticsConnectedLoopbackPreservesMedia(t *testing.T) {
	buf := &diagnosticLogBuffer{}
	e, err := NewEngine(Config{Logger: slog.New(slog.NewJSONHandler(buf, nil))})
	if err != nil {
		t.Fatal(err)
	}
	caller, track := newLoopbackCaller(t)
	defer caller.Close()
	s := session.New("diagnostic-connected", "synthetic-call", "a", "p", time.Now())
	answer, ms, err := e.Establish(context.Background(), s, callerOffer(t, caller), nil, Hooks{})
	if err != nil {
		t.Fatal(err)
	}
	defer ms.Terminate("test_done")
	if err := caller.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		_ = writeSilence(track)
		if s.Stats().InboundPackets > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if s.Stats().InboundPackets == 0 {
		t.Fatal("real loopback RTP did not flow")
	}
	if err := ms.SendOpus(umedia.OpusFrame{Data: silentOpusFrame, Duration: 20 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	ms.Terminate("test_done")
	if len(findEvents(buf, "first outbound opus on ready transport")) != 1 {
		t.Fatal("missing first connected transport write")
	}
	found := false
	for _, r := range findEvents(buf, "ice candidate pair observed") {
		if r["selected"] == true && r["dtls_state"] == "connected" && r["check_responses_received"].(float64) > 0 {
			found = true
		}
	}
	if !found {
		t.Fatal("selected pair and real STUN success not captured")
	}
	if len(findEvents(buf, "media ready")) != 1 {
		t.Fatal("media readiness behavior changed")
	}
}
