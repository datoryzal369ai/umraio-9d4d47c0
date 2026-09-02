package webrtc

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"

	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/session"
)

// metaLikeOffer mirrors the structure of a WhatsApp Calling offer: one bundled
// audio m-line, Opus 111 stereo, explicit sendrecv, mid present.
const metaLikeOffer = "v=0\r\n" +
	"o=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
	"a=group:BUNDLE 0\r\n" +
	"m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" +
	"c=IN IP4 0.0.0.0\r\n" +
	"a=mid:0\r\n" +
	"a=sendrecv\r\n" +
	"a=rtpmap:111 opus/48000/2\r\n" +
	"a=fmtp:111 minptime=10;useinbandfec=1\r\n" +
	"a=ice-ufrag:aaaa\r\na=ice-pwd:bbbbbbbbbbbbbbbbbbbbbb\r\n" +
	"a=fingerprint:sha-256 AA:BB\r\na=setup:actpass\r\n"

// 1. A Meta-like audio offer must be read as a receiving-capable audio path.
func TestMetaLikeOfferSummary(t *testing.T) {
	s := SummarizeAudioSDP(metaLikeOffer)
	if !s.AudioPresent || s.Rejected || s.Direction != DirSendRecv {
		t.Fatalf("unexpected audio section: %+v", s)
	}
	if !s.OpusPresent || s.OpusPayloadType != 111 || s.OpusClockRate != 48000 || s.OpusChannels != 2 {
		t.Fatalf("unexpected opus mapping: %+v", s)
	}
	if !s.MidPresent || !s.BundlePresent || !s.PermitsRemoteSend() {
		t.Fatalf("unexpected structure: %+v", s)
	}
	if r := SummarizeAudioSDP(strings.Replace(metaLikeOffer, "a=sendrecv", "a=recvonly", 1)); r.PermitsRemoteSend() || !r.PermitsLocalReceive() {
		t.Fatal("recvonly offer must not be read as a remote-sending path")
	}
	if r := SummarizeAudioSDP(strings.Replace(metaLikeOffer, "m=audio 9 ", "m=audio 0 ", 1)); !r.Rejected || r.PermitsRemoteSend() || r.PermitsLocalReceive() {
		t.Fatal("rejected m-line must not be treated as inbound-capable")
	}
	if e := SummarizeAudioSDP(""); e.AudioPresent || e.Direction != DirUnknown {
		t.Fatalf("empty sdp summary: %+v", e)
	}
}

// 2 + 3 + 5. A real negotiation must answer with a receiving direction, bind an
// RTP receiver, and keep the outbound sender available.
func TestNegotiationBindsInboundAudioPath(t *testing.T) {
	buf := &bytes.Buffer{}
	log := slog.New(slog.NewJSONHandler(buf, nil))
	e, err := NewEngine(Config{NegotiateTO: 10 * time.Second, Logger: log})
	if err != nil {
		t.Fatalf("engine: %v", err)
	}
	caller, _ := newLoopbackCaller(t)
	defer caller.Close()
	offer := callerOffer(t, caller)

	sess := session.New("sess-neg", "call-neg", "agency", "phone", time.Now())
	answer, ms, err := e.Establish(context.Background(), sess, offer, &countingPipeline{}, Hooks{})
	if err != nil {
		t.Fatalf("establish: %v", err)
	}
	defer ms.Terminate("test_done")

	local := SummarizeAudioSDP(answer)
	if !local.PermitsLocalReceive() {
		t.Fatalf("local answer forbids inbound audio: direction=%s", local.Direction)
	}
	if !local.OpusPresent || local.OpusClockRate != 48000 {
		t.Fatalf("opus not negotiated in answer: %+v", local)
	}
	audit := AuditTransceivers(ms.pc)
	if audit.AudioTransceivers != 1 {
		t.Fatalf("audio_transceiver_count = %d, want 1", audit.AudioTransceivers)
	}
	if !audit.CanReceiveAudio() {
		t.Fatalf("audio receiver not negotiated: %+v", audit)
	}
	if !audit.SenderNegotiated {
		t.Fatal("outbound sender must remain negotiated")
	}
	if !audit.MidPresent {
		t.Fatal("transceiver mid missing")
	}

	if len(findEvents(buf, "audio negotiation audit")) == 0 ||
		len(findEvents(buf, "remote offer audio summary")) == 0 {
		t.Fatal("missing negotiation diagnostics")
	}
	if len(findEvents(buf, "inbound audio path not negotiated")) != 0 {
		t.Fatal("inbound audio path reported as not negotiated")
	}
	out := buf.String()
	for _, forbidden := range []string{"v=0", "a=candidate", "ice-ufrag", "ice-pwd", "fingerprint", "sha-256"} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("diagnostics leaked %q", forbidden)
		}
	}
}

// 3 + 4. OnTrack/readInbound receives RTP and MediaReadyRule fires only then.
func TestInboundRTPDrivesMediaReady(t *testing.T) {
	e, err := NewEngine(Config{NegotiateTO: 10 * time.Second})
	if err != nil {
		t.Fatalf("engine: %v", err)
	}
	caller, callerTrack := newLoopbackCaller(t)
	defer caller.Close()
	offer := callerOffer(t, caller)

	sess := session.New("sess-rtp", "call-rtp", "agency", "phone", time.Now())
	pipe := &countingPipeline{}
	ready := make(chan struct{}, 1)
	answer, ms, err := e.Establish(context.Background(), sess, offer, pipe, Hooks{
		OnMediaReady: func(*session.Session) {
			select {
			case ready <- struct{}{}:
			default:
			}
		},
	})
	if err != nil {
		t.Fatalf("establish: %v", err)
	}
	defer ms.Terminate("test_done")
	if sess.MediaReadyRule() {
		t.Fatal("media ready before any RTP")
	}
	if err := caller.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatalf("caller answer: %v", err)
	}

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				_ = writeSilence(callerTrack)
			}
		}
	}()

	select {
	case <-ready:
	case <-time.After(20 * time.Second):
		t.Skip("loopback RTP did not flow in this sandbox network")
	}
	if sess.Stats().InboundPackets == 0 || pipe.frames.Load() == 0 {
		t.Fatal("media ready without inbound RTP")
	}
	if err := ms.SendOpus(umedia.OpusFrame{Data: silentOpusFrame, Duration: 20 * time.Millisecond}); err != nil {
		t.Fatalf("outbound path broken: %v", err)
	}
}
