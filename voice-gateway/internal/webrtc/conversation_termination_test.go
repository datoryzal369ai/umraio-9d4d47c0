package webrtc

import (
	"context"
	"encoding/base64"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"
	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/session"
)

type farewellTurns struct{ calls atomic.Int64 }

func (f *farewellTurns) Turn(_ context.Context, _ umedia.TurnRequest) (*umedia.TurnResponse, error) {
	f.calls.Add(1)
	frames := make([][]byte, 8)
	for i := range frames {
		frames[i] = silentOpusFrame
	}
	return &umedia.TurnResponse{
		ReplyOggBase64: base64.StdEncoding.EncodeToString(umedia.WriteOggOpus(frames, 2, 960)),
		EndCall:        true, Reason: "conversation_complete",
	}, nil
}

// Exercise the REAL MediaSession termination path, not just a fake transport.
// The unfixed turn -> Terminate -> pipeline.Close/Wait cycle cannot emit the
// callback. The terminal label alone is deliberately insufficient here.
func TestConversationCompleteClosesPeerAfterFarewellAndEmitsCallback(t *testing.T) {
	var logs diagnosticLogBuffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	engine, err := NewEngine(Config{Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	caller, _ := newLoopbackCaller(t)
	defer caller.Close()
	client := &farewellTurns{}
	pipe := umedia.NewConversationPipeline("call-farewell", client, umedia.ConversationConfig{
		VAD: umedia.VADConfig{FrameMs: 20, SpeechMinBytes: 40, StartFrames: 2,
			EndSilenceMs: 60, MinUtteranceMs: 40, MaxUtteranceMs: 1000},
		TurnTimeout: 5 * time.Second,
	}, logger)
	sess := session.New("ms_farewell", "call-farewell", "test-agency", "test-phone", time.Now())
	ended := make(chan string, 2)
	answer, ms, err := engine.Establish(context.Background(), sess, callerOffer(t, caller), pipe,
		Hooks{OnTerminated: func(_ *session.Session, reason string) { ended <- reason }})
	if err != nil {
		t.Fatal(err)
	}
	// Direct peer cleanup remains possible even if the tested self-wait recurs.
	defer ms.pc.Close()
	if err := caller.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for ms.ConnectionState() != pion.PeerConnectionStateConnected {
		select {
		case <-deadline.C:
			t.Fatal("loopback transport did not connect")
		case <-tick.C:
		}
	}
	pipe.StartGreeting() // accept notification, with automatic greeting disabled
	for i := 0; i < 6; i++ {
		pipe.OnInbound(umedia.OpusFrame{Data: make([]byte, 120)})
	}
	for i := 0; i < 4; i++ {
		pipe.OnInbound(umedia.OpusFrame{Data: silentOpusFrame})
	}
	select {
	case reason := <-ended:
		if reason != "conversation_complete" {
			t.Fatalf("unexpected termination reason %q", reason)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("farewell turn deadlocked before PeerConnection.Close/termination callback")
	}
	if ms.ConnectionState() != pion.PeerConnectionStateClosed || sess.State() != session.StateTerminated {
		t.Fatalf("callback preceded actual closure: peer=%s session=%s", ms.ConnectionState(), sess.State())
	}
	if sess.Stats().OutboundPackets != 8 || client.calls.Load() != 1 {
		t.Fatalf("farewell clipped or another turn dispatched: packets=%d turns=%d", sess.Stats().OutboundPackets, client.calls.Load())
	}
	metrics := pipe.LastMetrics()
	if metrics == nil || metrics.PlaybackCompleteMs < 150 {
		t.Fatalf("farewell playback did not drain before termination: %+v", metrics)
	}
	playback, terminating := -1, -1
	for i, entry := range logLines(&logs) {
		switch entry["msg"] {
		case "conversation_audio_timing":
			playback = i
		case "media session terminating":
			terminating = i
		}
	}
	if playback < 0 || terminating <= playback {
		t.Fatal("Terminate ran before farewell playback completion")
	}
	ms.Terminate("duplicate")
	select {
	case <-ended:
		t.Fatal("duplicate termination callback")
	default:
	}
}
