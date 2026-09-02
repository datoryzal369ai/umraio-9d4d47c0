// Package webrtc owns the media plane: ICE, DTLS/SRTP, RTP and Opus. It makes
// no business decisions and reaches no database, Meta API or AI provider.
package webrtc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	pion "github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/session"
)

// OpusPayloadType is the only audio codec this gateway negotiates.
// PCMA/PCMU are deliberately not registered.
const OpusPayloadType = 111

// Config describes the media-plane network posture.
type Config struct {
	// UDPMux is the single, shared ICE UDP mux for all peer connections.
	// It must be created before the engine (see NewUDPMux).
	UDPMux      ice.UDPMux
	NAT1To1IPs  []string
	ICEServers  []pion.ICEServer
	NegotiateTO time.Duration
	// Logger receives non-sensitive media diagnostics only.
	Logger *slog.Logger
}

// Hooks are the media-plane callbacks consumed by the API layer.
type Hooks struct {
	OnMediaReady func(s *session.Session)
	OnTerminated func(s *session.Session, reason string)
}

// Engine builds peer connections with a fixed, audited configuration.
type Engine struct {
	api *pion.API
	cfg Config
}

func NewEngine(cfg Config) (*Engine, error) {
	m := &pion.MediaEngine{}
	if err := m.RegisterCodec(pion.RTPCodecParameters{
		RTPCodecCapability: pion.RTPCodecCapability{
			MimeType:     pion.MimeTypeOpus,
			ClockRate:    48000,
			Channels:     2,
			SDPFmtpLine:  "minptime=10;useinbandfec=1",
			RTCPFeedback: nil,
		},
		PayloadType: OpusPayloadType,
	}, pion.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register opus: %w", err)
	}

	se := pion.SettingEngine{}
	if cfg.UDPMux != nil {
		se.SetICEUDPMux(cfg.UDPMux)
	}
	if len(cfg.NAT1To1IPs) > 0 {
		se.SetNAT1To1IPs(cfg.NAT1To1IPs, pion.ICECandidateTypeHost)
	}
	if cfg.NegotiateTO <= 0 {
		cfg.NegotiateTO = 10 * time.Second
	}

	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Engine{
		api: pion.NewAPI(pion.WithMediaEngine(m), pion.WithSettingEngine(se)),
		cfg: cfg,
	}, nil
}

// MediaSession is the live WebRTC leg for one call and implements
// media.Transport for the (future) ASR/TTS pipeline.
type MediaSession struct {
	pc       *pion.PeerConnection
	out      *pion.TrackLocalStaticSample
	sess     *session.Session
	pipeline umedia.Pipeline
	hooks    Hooks
	log      *slog.Logger

	closeOnce sync.Once
	mu        sync.Mutex
	closed    bool
}

var ErrClosed = errors.New("webrtc: media session closed")

// Establish consumes a validated remote offer and returns a real, locally
// generated SDP answer. No SDP is ever fabricated: the answer comes from the
// peer connection after ICE gathering completes.
func (e *Engine) Establish(
	ctx context.Context,
	s *session.Session,
	offerSDP string,
	pipeline umedia.Pipeline,
	hooks Hooks,
) (string, *MediaSession, error) {
	if err := ValidateOffer(offerSDP); err != nil {
		return "", nil, err
	}
	if pipeline == nil {
		pipeline = &umedia.NoopPipeline{}
	}

	pc, err := e.api.NewPeerConnection(pion.Configuration{ICEServers: e.cfg.ICEServers})
	if err != nil {
		return "", nil, fmt.Errorf("peer connection: %w", err)
	}

	track, err := pion.NewTrackLocalStaticSample(
		pion.RTPCodecCapability{MimeType: pion.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "umraio-"+s.ID,
	)
	if err != nil {
		_ = pc.Close()
		return "", nil, fmt.Errorf("outbound track: %w", err)
	}
	if _, err := pc.AddTrack(track); err != nil {
		_ = pc.Close()
		return "", nil, fmt.Errorf("add track: %w", err)
	}

	log := e.cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	ms := &MediaSession{pc: pc, out: track, sess: s, pipeline: pipeline, hooks: hooks, log: log}
	log.Info("media session created", "call_id", s.CallID, "session_id", s.ID,
		"udp_mux_configured", e.cfg.UDPMux != nil,
		"nat_1to1_configured", len(e.cfg.NAT1To1IPs) > 0,
		"nat_1to1_count", len(e.cfg.NAT1To1IPs),
		"ice_servers_configured", len(e.cfg.ICEServers) > 0)

	_ = s.Advance(session.StateConnecting, "", time.Now())

	pc.OnConnectionStateChange(func(st pion.PeerConnectionState) {
		log.Info("peer connection state", "call_id", s.CallID, "session_id", s.ID,
			"peer_connection_state", st.String())
		switch st {
		case pion.PeerConnectionStateConnected:
			s.MarkICEConnected(time.Now())
			s.MarkOutboundReady()
			ms.maybeFireMediaReady()
		case pion.PeerConnectionStateFailed:
			_ = s.Advance(session.StateFailed, "ice_failed", time.Now())
			ms.Terminate("ice_failed")
		case pion.PeerConnectionStateDisconnected, pion.PeerConnectionStateClosed:
			ms.Terminate("peer_disconnected")
		}
	})

	pc.OnICEConnectionStateChange(func(st pion.ICEConnectionState) {
		log.Info("ice connection state", "call_id", s.CallID, "session_id", s.ID,
			"ice_connection_state", st.String())
	})

	pc.OnICEGatheringStateChange(func(st pion.ICEGathererState) {
		log.Info("ice gathering state", "call_id", s.CallID, "session_id", s.ID,
			"ice_gathering_state", st.String())
	})

	pc.OnTrack(func(remote *pion.TrackRemote, _ *pion.RTPReceiver) {
		if remote.Kind() != pion.RTPCodecTypeAudio {
			return
		}
		go ms.readInbound(remote)
	})

	if err := pc.SetRemoteDescription(pion.SessionDescription{
		Type: pion.SDPTypeOffer, SDP: NormalizeOfferTerminator(offerSDP),
	}); err != nil {
		_ = pc.Close()
		return "", nil, fmt.Errorf("set remote description: %w", err)
	}
	_ = s.Advance(session.StateMediaNegotiating, "", time.Now())

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		_ = pc.Close()
		return "", nil, fmt.Errorf("create answer: %w", err)
	}
	gather := pion.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		_ = pc.Close()
		return "", nil, fmt.Errorf("set local description: %w", err)
	}

	gctx, cancel := context.WithTimeout(ctx, e.cfg.NegotiateTO)
	defer cancel()
	select {
	case <-gather:
	case <-gctx.Done():
		log.Warn("ice gathering state", "call_id", s.CallID, "session_id", s.ID,
			"ice_gathering_state", "timeout")
		_ = pc.Close()
		return "", nil, errors.New("webrtc: ice gathering timed out")
	}

	local := pc.LocalDescription()
	if local == nil || local.SDP == "" {
		_ = pc.Close()
		return "", nil, errors.New("webrtc: no local description produced")
	}
	log.Info("local answer generated",
		append([]any{"call_id", s.CallID, "session_id", s.ID}, SummarizeAnswer(local.SDP).LogAttrs()...)...)
	if err := pipeline.Attach(ctx, ms); err != nil {
		_ = pc.Close()
		return "", nil, fmt.Errorf("attach pipeline: %w", err)
	}
	return local.SDP, ms, nil
}

func (ms *MediaSession) readInbound(remote *pion.TrackRemote) {
	for {
		pkt, _, err := remote.ReadRTP()
		if err != nil {
			ms.Terminate("inbound_rtp_closed")
			return
		}
		if len(pkt.Payload) == 0 {
			continue
		}
		ms.sess.RecordInbound(time.Now())
		ms.pipeline.OnInbound(umedia.OpusFrame{
			Data:      pkt.Payload,
			Duration:  20 * time.Millisecond,
			Sequence:  pkt.SequenceNumber,
			Timestamp: pkt.Timestamp,
		})
		ms.maybeFireMediaReady()
	}
}

// maybeFireMediaReady applies session.MediaReadyRule and emits at most once.
func (ms *MediaSession) maybeFireMediaReady() {
	now := time.Now()
	if !ms.sess.TryFireMediaReady(now) {
		return
	}
	_ = ms.sess.Advance(session.StateMediaReady, "", now)
	_ = ms.sess.Advance(session.StateActive, "", now)
	if ms.hooks.OnMediaReady != nil {
		go ms.hooks.OnMediaReady(ms.sess)
	}
}

// SendOpus implements media.Transport.
func (ms *MediaSession) SendOpus(frame umedia.OpusFrame) error {
	ms.mu.Lock()
	closed := ms.closed
	ms.mu.Unlock()
	if closed {
		return ErrClosed
	}
	d := frame.Duration
	if d <= 0 {
		d = 20 * time.Millisecond
	}
	if err := ms.out.WriteSample(media.Sample{Data: frame.Data, Duration: d}); err != nil {
		return err
	}
	ms.sess.RecordOutbound()
	return nil
}

// Terminate implements media.Transport and is idempotent.
func (ms *MediaSession) Terminate(reason string) {
	ms.closeOnce.Do(func() {
		ms.mu.Lock()
		ms.closed = true
		ms.mu.Unlock()
		now := time.Now()
		if !session.IsTerminal(ms.sess.State()) {
			_ = ms.sess.Advance(session.StateTerminating, reason, now)
			_ = ms.sess.Advance(session.StateTerminated, reason, now)
		}
		ms.pipeline.Close(reason)
		_ = ms.pc.Close()
		if ms.hooks.OnTerminated != nil {
			go ms.hooks.OnTerminated(ms.sess, reason)
		}
	})
}

// ConnectionState exposes the raw peer state for health reporting.
func (ms *MediaSession) ConnectionState() pion.PeerConnectionState {
	return ms.pc.ConnectionState()
}
