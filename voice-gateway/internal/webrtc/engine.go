// Package webrtc owns the media plane: ICE, DTLS/SRTP, RTP and Opus. It makes
// no business decisions and reaches no database, Meta API or AI provider.
package webrtc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
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

	pipelineMode string
	inbound      atomic.Uint64
	outbound     atomic.Uint64
	trackFired   atomic.Bool
	accepted     atomic.Bool
	outboundErrs atomic.Uint64
}

// diagEvery bounds progress logging: first packet, then every N packets.
const diagEvery = 100

// sanitizeCodec constrains any codec string before it reaches a log sink.
func sanitizeCodec(v string) string {
	if len(v) > 64 {
		v = v[:64]
	}
	for _, r := range v {
		if r < 0x20 || r > 0x7e {
			return "unknown"
		}
	}
	if v == "" {
		return "unknown"
	}
	return v
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
	// An explicit SENDRECV audio transceiver is required: AddTrack alone lets
	// Pion settle on a send-capable-only audio path, in which case no RTP
	// receiver is bound and OnTrack can never fire even though ICE/DTLS come
	// up cleanly. WhatsApp Calling only streams caller audio when the answer
	// advertises a receiving direction.
	if _, err := pc.AddTransceiverFromTrack(track, pion.RTPTransceiverInit{
		Direction: pion.RTPTransceiverDirectionSendrecv,
	}); err != nil {
		_ = pc.Close()
		return "", nil, fmt.Errorf("add audio transceiver: %w", err)
	}

	log := e.cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	mode := umedia.PipelineMode(pipeline)
	ms := &MediaSession{pc: pc, out: track, sess: s, pipeline: pipeline, hooks: hooks, log: log, pipelineMode: mode}
	log.Info("media pipeline selected", "call_id", s.CallID, "session_id", s.ID, "pipeline_mode", mode)
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
			ms.logTransportDiagnostics()
			ms.maybeFireMediaReady()
		case pion.PeerConnectionStateFailed:
			_ = s.Advance(session.StateFailed, "ice_failed", time.Now())
			ms.Terminate("ice_failed")
		case pion.PeerConnectionStateDisconnected:
			// RECOVERABLE: ICE may re-establish after a transient network blip.
			// Terminating here kills otherwise healthy calls. Only Failed/Closed
			// are terminal.
			log.Warn("peer connection disconnected (recoverable)",
				"call_id", s.CallID, "session_id", s.ID)
		case pion.PeerConnectionStateClosed:
			ms.Terminate("peer_closed")
		}

	})

	pc.OnICEConnectionStateChange(func(st pion.ICEConnectionState) {
		log.Info("ice connection state", "call_id", s.CallID, "session_id", s.ID,
			"ice_connection_state", st.String())
	})

	pc.OnICEGatheringStateChange(func(st pion.ICEGatheringState) {
		log.Info("ice gathering state", "call_id", s.CallID, "session_id", s.ID,
			"ice_gathering_state", st.String())
	})

	pc.OnTrack(func(remote *pion.TrackRemote, _ *pion.RTPReceiver) {
		ms.trackFired.Store(true)
		if remote.Kind() != pion.RTPCodecTypeAudio {
			log.Info("non audio track ignored", "call_id", s.CallID, "session_id", s.ID,
				"on_track_fired", true)
			return
		}
		codec := remote.Codec()
		log.Info("inbound audio track received", "call_id", s.CallID, "session_id", s.ID,
			"codec_mime", sanitizeCodec(codec.MimeType),
			"payload_type", uint8(codec.PayloadType),
			"clock_rate", codec.ClockRate,
			"channels", codec.Channels)
		go ms.readInbound(remote)
	})

	remoteAudio := SummarizeAudioSDP(offerSDP)
	log.Info("remote offer audio summary",
		append([]any{"call_id", s.CallID, "session_id", s.ID}, remoteAudio.LogAttrs("remote")...)...)

	if err := pc.SetRemoteDescription(pion.SessionDescription{
		Type: pion.SDPTypeOffer, SDP: NormalizeOfferTerminator(offerSDP),
	}); err != nil {
		_ = pc.Close()
		return "", nil, fmt.Errorf("set remote description: %w", err)
	}
	_ = s.Advance(session.StateMediaNegotiating, "", time.Now())

	// Post-offer transceiver posture: purely observational. The receiving
	// direction is guaranteed by the explicit SENDRECV transceiver added
	// before SetRemoteDescription.
	if pre := AuditTransceivers(pc); remoteAudio.PermitsRemoteSend() && !pre.CanReceiveAudio() {
		log.Warn("audio receiver not bound after remote offer",
			append([]any{"call_id", s.CallID, "session_id", s.ID}, pre.LogAttrs()...)...)
	}

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
	candV4, candV6 := CandidateFamilies(local.SDP)
	log.Info("local answer generated",
		append([]any{"call_id", s.CallID, "session_id", s.ID,
			"candidate_ipv4_count", candV4, "candidate_ipv6_count", candV6},
			SummarizeAnswer(local.SDP).LogAttrs()...)...)

	localAudio := SummarizeAudioSDP(local.SDP)
	audit := AuditTransceivers(pc)
	fields := append([]any{"call_id", s.CallID, "session_id", s.ID}, localAudio.LogAttrs("local")...)
	fields = append(fields, audit.LogAttrs()...)
	fields = append(fields, "inbound_audio_permitted", localAudio.PermitsLocalReceive())
	log.Info("audio negotiation audit", fields...)
	if !localAudio.PermitsLocalReceive() || !audit.CanReceiveAudio() {
		log.Warn("inbound audio path not negotiated", "call_id", s.CallID, "session_id", s.ID,
			"local_audio_direction", localAudio.Direction,
			"audio_transceiver_direction", audit.Direction,
			"audio_receiver_negotiated", audit.ReceiverNegotiated)
	}

	if err := pipeline.Attach(ctx, ms); err != nil {
		log.Warn("media pipeline attach failed", "call_id", s.CallID, "session_id", s.ID,
			"pipeline_mode", mode, "error_class", "pipeline_attach")
		_ = pc.Close()
		return "", nil, fmt.Errorf("attach pipeline: %w", err)
	}
	log.Info("media pipeline attached", "call_id", s.CallID, "session_id", s.ID, "pipeline_mode", mode)
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
		n := ms.inbound.Add(1)
		if n == 1 {
			ms.log.Info("first inbound rtp", "call_id", ms.sess.CallID, "session_id", ms.sess.ID,
				"payload_length", len(pkt.Payload),
				"sequence_present", true, "timestamp_present", true)
		}
		if n == 1 || n%diagEvery == 0 {
			ms.log.Info("inbound rtp progress", "call_id", ms.sess.CallID, "session_id", ms.sess.ID,
				"inbound_packets", n)
		}
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
	st := ms.sess.Stats()
	ms.log.Info("media ready", "call_id", ms.sess.CallID, "session_id", ms.sess.ID,
		"state", string(st.State),
		"inbound_packets", st.InboundPackets, "outbound_packets", st.OutboundPackets,
		"pipeline_mode", ms.pipelineMode)
	if ms.hooks.OnMediaReady != nil {
		go ms.hooks.OnMediaReady(ms.sess)
	}
}

// logTransportDiagnostics emits family/type/state facts only. It never logs an
// IP address, ICE credential, DTLS fingerprint or SDP line.
func (ms *MediaSession) logTransportDiagnostics() {
	pairType, localFam, remoteFam := "unknown", "unknown", "unknown"
	if pair, err := selectedPair(ms.pc); err == nil && pair != nil {
		pairType = pair.Local.Typ.String() + "/" + pair.Remote.Typ.String()
		localFam = addressFamily(pair.Local.Address)
		remoteFam = addressFamily(pair.Remote.Address)
	}
	dtls := "unknown"
	if t := ms.pc.SCTP(); t != nil && t.Transport() != nil {
		dtls = t.Transport().State().String()
	}
	ms.log.Info("transport diagnostics", "call_id", ms.sess.CallID, "session_id", ms.sess.ID,
		"selected_pair_type", pairType,
		"selected_local_family", localFam,
		"selected_remote_family", remoteFam,
		"dtls_transport_state", dtls,
		"on_track_fired", ms.trackFired.Load(),
		"inbound_packets", ms.inbound.Load(),
		"outbound_packets", ms.outbound.Load())
}

func selectedPair(pc *pion.PeerConnection) (*pion.ICECandidatePair, error) {
	transport := pc.SCTP()
	if transport == nil || transport.Transport() == nil || transport.Transport().ICETransport() == nil {
		return nil, errors.New("webrtc: no ice transport")
	}
	return transport.Transport().ICETransport().GetSelectedCandidatePair()
}

// addressFamily reduces an address to an enum. The address itself is discarded.
func addressFamily(addr string) string {
	if addr == "" {
		return "unknown"
	}
	if strings.Contains(addr, ":") {
		return "ipv6"
	}
	return "ipv4"
}

// NotifyAccepted is the explicit "Meta accept completed" signal from the
// control plane. It is the ONLY trigger for the opening greeting: exactly one
// greeting per call, never before accept, never after Close.
func (ms *MediaSession) NotifyAccepted() string {
	ms.mu.Lock()
	closed := ms.closed
	ms.mu.Unlock()
	if closed {
		ms.log.Info("post_accept_greeting", "call_id", ms.sess.CallID, "session_id", ms.sess.ID,
			"outcome", string(umedia.GreetingClosed))
		return string(umedia.GreetingClosed)
	}
	ms.accepted.Store(true)
	greeter, ok := ms.pipeline.(umedia.Greeter)
	if !ok {
		ms.log.Info("post_accept_greeting", "call_id", ms.sess.CallID, "session_id", ms.sess.ID,
			"outcome", string(umedia.GreetingDisabled))
		return string(umedia.GreetingDisabled)
	}
	outcome := greeter.StartGreeting()
	ms.log.Info("post_accept_greeting", "call_id", ms.sess.CallID, "session_id", ms.sess.ID,
		"outcome", string(outcome), "pipeline_mode", ms.pipelineMode)
	return string(outcome)
}

// Accepted reports whether the control plane confirmed the Meta accept.
func (ms *MediaSession) Accepted() bool { return ms.accepted.Load() }

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
	first := ms.outbound.Load() == 0
	if err := ms.out.WriteSample(media.Sample{Data: frame.Data, Duration: d}); err != nil {
		if first && ms.outboundErrs.Add(1) == 1 {
			ms.log.Warn("first outbound rtp write failed", "call_id", ms.sess.CallID,
				"session_id", ms.sess.ID, "error_class", "outbound_write")
		}
		return err
	}
	ms.sess.RecordOutbound()
	n := ms.outbound.Add(1)
	if n == 1 {
		ms.log.Info("first outbound opus", "call_id", ms.sess.CallID, "session_id", ms.sess.ID,
			"payload_length", len(frame.Data), "duration_ms", d.Milliseconds())
	}
	if n == 1 || n%diagEvery == 0 {
		ms.log.Info("outbound opus progress", "call_id", ms.sess.CallID, "session_id", ms.sess.ID,
			"outbound_packets", n)
	}
	return nil
}

// Terminate implements media.Transport and is idempotent.
func (ms *MediaSession) Terminate(reason string) {
	ms.closeOnce.Do(func() {
		ms.mu.Lock()
		ms.closed = true
		ms.mu.Unlock()
		now := time.Now()
		pre := ms.sess.Stats()
		ms.log.Info("media session terminating", "call_id", ms.sess.CallID, "session_id", ms.sess.ID,
			"state", string(pre.State),
			"inbound_packets", pre.InboundPackets, "outbound_packets", pre.OutboundPackets,
			"media_ready", !pre.MediaReadyAt.IsZero(),
			"pipeline_mode", ms.pipelineMode,
			"reason", reason)
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
