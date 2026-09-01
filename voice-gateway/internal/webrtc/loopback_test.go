package webrtc

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/session"
)

// silentOpusFrame is a valid, decodable Opus silence packet (TOC + frame).
var silentOpusFrame = []byte{0xf8, 0xff, 0xfe}

type countingPipeline struct {
	frames atomic.Int64
	closed atomic.Bool
	tr     atomic.Value
}

func (p *countingPipeline) Attach(_ context.Context, t umedia.Transport) error {
	p.tr.Store(t)
	return nil
}
func (p *countingPipeline) OnInbound(umedia.OpusFrame) { p.frames.Add(1) }
func (p *countingPipeline) Close(string)               { p.closed.Store(true) }

// newLoopbackCaller builds a local pion peer that behaves like the remote
// WhatsApp endpoint: it offers Opus sendrecv and streams RTP once connected.
func newLoopbackCaller(t *testing.T) (*pion.PeerConnection, *pion.TrackLocalStaticSample) {
	t.Helper()
	m := &pion.MediaEngine{}
	if err := m.RegisterCodec(pion.RTPCodecParameters{
		RTPCodecCapability: pion.RTPCodecCapability{
			MimeType: pion.MimeTypeOpus, ClockRate: 48000, Channels: 2,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		},
		PayloadType: OpusPayloadType,
	}, pion.RTPCodecTypeAudio); err != nil {
		t.Fatal(err)
	}
	api := pion.NewAPI(pion.WithMediaEngine(m))
	pc, err := api.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	track, err := pion.NewTrackLocalStaticSample(
		pion.RTPCodecCapability{MimeType: pion.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "caller",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pc.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	return pc, track
}

func callerOffer(t *testing.T, pc *pion.PeerConnection) string {
	t.Helper()
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather := pion.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gather:
	case <-time.After(10 * time.Second):
		t.Fatal("caller ICE gathering timed out")
	}
	return pc.LocalDescription().SDP
}

func TestLoopbackNegotiatesOpusAndReachesMediaReady(t *testing.T) {
	engine, err := NewEngine(Config{NegotiateTO: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	caller, callerTrack := newLoopbackCaller(t)
	defer caller.Close()

	offer := callerOffer(t, caller)
	if err := ValidateOffer(offer); err != nil {
		t.Fatalf("real pion offer failed validation: %v", err)
	}

	sess := session.New("ms_loop", "call-loop", "ag_1", "pn_1", time.Now())
	pipe := &countingPipeline{}

	var mediaReady atomic.Int64
	readyCh := make(chan struct{}, 1)
	hooks := Hooks{
		OnMediaReady: func(*session.Session) {
			mediaReady.Add(1)
			select {
			case readyCh <- struct{}{}:
			default:
			}
		},
	}

	inboundAtGateway := make(chan struct{}, 1)
	callerGotAudio := make(chan struct{}, 1)
	caller.OnTrack(func(tr *pion.TrackRemote, _ *pion.RTPReceiver) {
		for {
			if _, _, err := tr.ReadRTP(); err != nil {
				return
			}
			select {
			case callerGotAudio <- struct{}{}:
			default:
			}
		}
	})

	answer, ms, err := engine.Establish(context.Background(), sess, offer, pipe, hooks)
	if err != nil {
		t.Fatalf("establish: %v", err)
	}
	defer ms.Terminate("test_done")

	if answer == "" {
		t.Fatal("gateway produced no SDP answer")
	}
	if !contains(answer, "opus/48000") {
		t.Fatal("answer did not negotiate opus")
	}
	if contains(answer, "PCMU") || contains(answer, "PCMA") {
		t.Fatal("answer must not negotiate PCMU/PCMA")
	}
	// Answer alone must never be treated as readiness.
	if sess.MediaReadyRule() {
		t.Fatal("media_ready must not hold immediately after SDP answer")
	}
	if mediaReady.Load() != 0 {
		t.Fatal("media_ready emitted before any RTP")
	}

	if err := caller.SetRemoteDescription(pion.SessionDescription{
		Type: pion.SDPTypeAnswer, SDP: answer,
	}); err != nil {
		t.Fatalf("caller could not accept gateway answer: %v", err)
	}

	// Caller streams real RTP audio until the gateway observes it.
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
				_ = callerTrack.WriteSample(media.Sample{Data: silentOpusFrame, Duration: 20 * time.Millisecond})
			}
		}
	}()
	go func() {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				_ = ms.SendOpus(umedia.OpusFrame{Data: silentOpusFrame, Duration: 20 * time.Millisecond})
			}
		}
	}()

	select {
	case <-readyCh:
	case <-time.After(20 * time.Second):
		t.Fatalf("media_ready never emitted; state=%s stats=%+v", sess.State(), sess.Stats())
	}
	close(inboundAtGateway)

	if got := sess.Stats().InboundPackets; got == 0 {
		t.Fatal("media_ready emitted without inbound RTP counters")
	}
	if sess.State() != session.StateActive {
		t.Fatalf("expected ACTIVE after media_ready, got %s", sess.State())
	}
	if pipe.frames.Load() == 0 {
		t.Fatal("pipeline received no inbound opus frames")
	}

	select {
	case <-callerGotAudio:
	case <-time.After(15 * time.Second):
		t.Fatal("caller never received outbound RTP from gateway")
	}
	if sess.Stats().OutboundPackets == 0 {
		t.Fatal("outbound counters not recorded")
	}

	// media_ready is emitted at most once.
	sess.RecordInbound(time.Now())
	time.Sleep(100 * time.Millisecond)
	if mediaReady.Load() != 1 {
		t.Fatalf("media_ready emitted %d times, expected exactly 1", mediaReady.Load())
	}
}

func TestTerminateIsIdempotentAndClosesPipeline(t *testing.T) {
	engine, err := NewEngine(Config{NegotiateTO: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	caller, _ := newLoopbackCaller(t)
	defer caller.Close()

	sess := session.New("ms_term", "call-term", "ag_1", "pn_1", time.Now())
	pipe := &countingPipeline{}
	var terminated atomic.Int64
	_, ms, err := engine.Establish(context.Background(), sess, callerOffer(t, caller), pipe,
		Hooks{OnTerminated: func(*session.Session, string) { terminated.Add(1) }})
	if err != nil {
		t.Fatal(err)
	}

	ms.Terminate("caller_hangup")
	ms.Terminate("caller_hangup")
	time.Sleep(200 * time.Millisecond)

	if sess.State() != session.StateTerminated {
		t.Fatalf("expected TERMINATED, got %s", sess.State())
	}
	if sess.TerminationReason() != "caller_hangup" {
		t.Fatalf("unexpected reason %q", sess.TerminationReason())
	}
	if !pipe.closed.Load() {
		t.Fatal("pipeline was not closed")
	}
	if terminated.Load() != 1 {
		t.Fatalf("terminate hook fired %d times", terminated.Load())
	}
	if err := ms.SendOpus(umedia.OpusFrame{Data: silentOpusFrame}); err == nil {
		t.Fatal("sending after terminate must fail")
	}
}

func TestEstablishRejectsInvalidOffer(t *testing.T) {
	engine, err := NewEngine(Config{})
	if err != nil {
		t.Fatal(err)
	}
	sess := session.New("ms_bad", "call-bad", "ag", "pn", time.Now())
	if _, _, err := engine.Establish(context.Background(), sess, "not an sdp", nil, Hooks{}); err == nil {
		t.Fatal("expected rejection of invalid offer")
	}
	if sess.State() != session.StateAuthenticating {
		t.Fatalf("session should not advance on rejected offer, got %s", sess.State())
	}
}

func contains(hay, needle string) bool {
	return len(hay) >= len(needle) && (len(needle) == 0 || indexOf(hay, needle) >= 0)
}

func indexOf(hay, needle string) int {
	for i := 0; i+len(needle) <= len(hay); i++ {
		if hay[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
