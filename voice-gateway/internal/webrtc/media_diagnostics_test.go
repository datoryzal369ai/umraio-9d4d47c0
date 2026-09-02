package webrtc

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"

	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/session"
)

// A pipeline that names itself, so pipeline_mode is provably explicit.
type modedPipeline struct {
	countingPipeline
	mode     string
	attached atomic.Bool
}

func (p *modedPipeline) Mode() string { return p.mode }
func (p *modedPipeline) Attach(ctx context.Context, t umedia.Transport) error {
	p.attached.Store(true)
	return p.countingPipeline.Attach(ctx, t)
}

func logLines(buf *bytes.Buffer) []map[string]any {
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

func findEvents(buf *bytes.Buffer, msg string) []map[string]any {
	var out []map[string]any
	for _, m := range logLines(buf) {
		if m["msg"] == msg {
			out = append(out, m)
		}
	}
	return out
}

// NoopPipeline must be explicitly identifiable, and unknown implementations
// must never leak Go internals into the mode field.
func TestPipelineModeEnumeration(t *testing.T) {
	if got := umedia.PipelineMode(&umedia.NoopPipeline{}); got != umedia.ModeNoop {
		t.Fatalf("noop pipeline mode = %q", got)
	}
	if got := umedia.PipelineMode(umedia.NewConversationPipeline("c", nil, umedia.ConversationConfig{}, nil)); got != umedia.ModeRealtimeAI {
		t.Fatalf("conversation pipeline mode = %q", got)
	}
	if got := umedia.PipelineMode(&countingPipeline{}); got != umedia.ModeCustom {
		t.Fatalf("unnamed pipeline mode = %q", got)
	}
	if got := umedia.PipelineMode(nil); got != umedia.ModeUnknown {
		t.Fatalf("nil pipeline mode = %q", got)
	}
	if got := umedia.PipelineMode(&modedPipeline{mode: "leaky *webrtc.Thing"}); got != umedia.ModeUnknown {
		t.Fatalf("unsafe mode must be coerced, got %q", got)
	}
}

// MediaReadyRule ordering: ICE + outbound alone must not fire readiness.
func TestMediaReadyRequiresInboundRTP(t *testing.T) {
	s := session.New("s1", "c1", "a", "p", time.Now())
	s.MarkICEConnected(time.Now())
	s.MarkOutboundReady()
	if s.MediaReadyRule() || s.TryFireMediaReady(time.Now()) {
		t.Fatal("media ready fired before inbound RTP")
	}
	s.RecordInbound(time.Now())
	if !s.TryFireMediaReady(time.Now()) {
		t.Fatal("media ready did not fire after inbound RTP")
	}
	if s.TryFireMediaReady(time.Now()) {
		t.Fatal("media ready fired twice")
	}
}

// One real loopback call: track received, inbound RTP counted, media_ready
// exactly once, outbound Opus counted, termination stats correct, and no
// sensitive material anywhere in the diagnostics.
func TestMediaDiagnosticsEndToEnd(t *testing.T) {
	buf := &bytes.Buffer{}
	log := slog.New(slog.NewJSONHandler(buf, nil))
	e, err := NewEngine(Config{NegotiateTO: 10 * time.Second, Logger: log})
	if err != nil {
		t.Fatalf("engine: %v", err)
	}
	caller, callerTrack := newLoopbackCaller(t)
	defer caller.Close()
	offer := callerOffer(t, caller)

	pipe := &modedPipeline{mode: umedia.ModeRealtimeAI}
	sess := session.New("sess-media", "call-media", "agency", "phone", time.Now())
	answer, ms, err := e.Establish(context.Background(), sess, offer, pipe, Hooks{})
	if err != nil {
		t.Fatalf("establish: %v", err)
	}
	if err := caller.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatalf("caller answer: %v", err)
	}
	if !pipe.attached.Load() {
		t.Fatal("pipeline Attach was not invoked")
	}

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		_ = writeSilence(callerTrack)
		if sess.Stats().InboundPackets > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sess.Stats().InboundPackets == 0 {
		t.Skip("loopback RTP did not flow in this sandbox network")
	}

	if err := ms.SendOpus(umedia.OpusFrame{Data: silentOpusFrame, Duration: 20 * time.Millisecond}); err != nil {
		t.Fatalf("send opus: %v", err)
	}
	if got := sess.Stats().OutboundPackets; got != 1 {
		t.Fatalf("outbound counter = %d, want 1", got)
	}

	ms.Terminate("test_done")

	if got := len(findEvents(buf, "media ready")); got != 1 {
		t.Fatalf("media ready events = %d, want exactly 1", got)
	}
	for _, msg := range []string{
		"inbound audio track received", "first inbound rtp", "media pipeline selected",
		"media pipeline attached", "first outbound opus", "media session terminating",
	} {
		if len(findEvents(buf, msg)) == 0 {
			t.Fatalf("missing diagnostic %q", msg)
		}
	}
	term := findEvents(buf, "media session terminating")[0]
	if term["media_ready"] != true || term["reason"] != "test_done" {
		t.Fatalf("unexpected termination stats: %+v", term)
	}
	if term["outbound_packets"].(float64) != 1 || term["inbound_packets"].(float64) < 1 {
		t.Fatalf("unexpected termination counters: %+v", term)
	}
	if findEvents(buf, "media pipeline selected")[0]["pipeline_mode"] != umedia.ModeRealtimeAI {
		t.Fatal("pipeline_mode not reported")
	}

	out := buf.String()
	for _, forbidden := range []string{"v=0", "a=candidate", "ice-ufrag", "ice-pwd", "fingerprint", "sha-256", "m=audio"} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("diagnostics leaked %q", forbidden)
		}
	}
}

func TestSanitizeCodecConstrainsOutput(t *testing.T) {
	if sanitizeCodec("audio/opus") != "audio/opus" {
		t.Fatal("valid codec altered")
	}
	if sanitizeCodec("") != "unknown" || sanitizeCodec("bad\nvalue") != "unknown" {
		t.Fatal("unsafe codec not sanitized")
	}
	if len(sanitizeCodec(strings.Repeat("x", 500))) != 64 {
		t.Fatal("codec not truncated")
	}
}
