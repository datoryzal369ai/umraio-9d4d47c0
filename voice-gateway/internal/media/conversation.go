package media

// ConversationPipeline is the real-time listen → reason → speak loop of the
// media plane. It contains NO business intelligence: every transcript, every
// decision and every synthesised reply comes from the UMRAIO control plane over
// one signed HTTP turn call. The gateway only segments audio, ships it, and
// plays back what it is given — cancelling instantly when the caller speaks.

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// TurnKind distinguishes the opening greeting from a caller utterance.
const (
	TurnKindGreeting  = "greeting"
	TurnKindUtterance = "utterance"
)

// TurnRequest is what the gateway asks the control plane to resolve.
// AudioOggBase64 is empty for a greeting.
type TurnRequest struct {
	CallID         string `json:"call_id"`
	Sequence       int    `json:"sequence"`
	Kind           string `json:"kind"`
	AudioOggBase64 string `json:"audio_ogg_base64,omitempty"`
	DurationMs     int    `json:"duration_ms"`
	// MediaMetrics is additive, sanitized instrumentation only: durations in
	// milliseconds, never audio, text or identifiers. It carries THIS turn's
	// VAD finalisation and the media-plane timings of the turn that has just
	// finished playing (the only moment they are all known).
	MediaMetrics *TurnMediaMetrics `json:"media_metrics,omitempty"`
}

// TurnMediaMetrics are the media-plane halves of the end-to-end latency
// budget. All values are whole milliseconds; zero means "not measured".
type TurnMediaMetrics struct {
	// VADFinalizeMs: last caller SPEECH frame -> utterance closed by the VAD.
	VADFinalizeMs int `json:"vad_finalize_ms,omitempty"`
	// PrevSequence identifies the turn the playback metrics below belong to.
	PrevSequence int `json:"prev_sequence,omitempty"`
	// TTSMs: MiniMax synthesis round trip (provider only).
	TTSMs int `json:"tts_ms,omitempty"`
	// TTSEncodeMs: PCM -> native Opus packetisation.
	TTSEncodeMs int `json:"tts_encode_ms,omitempty"`
	// PlaybackStartMs: control-plane turn dispatch -> first outbound packet.
	PlaybackStartMs int `json:"playback_start_ms,omitempty"`
	// SpeechEndToFirstAudioMs: caller stopped speaking -> caller hears audio.
	SpeechEndToFirstAudioMs int `json:"speech_end_to_first_audio_ms,omitempty"`
}

// TurnResponse is the control plane's answer.
//
// Two shapes are supported, in this order:
//  1. SpeechText — the control plane decided WHAT to say; the media plane
//     synthesises it with the LOCKED MiniMax voice and encodes native Opus.
//     This is the production path: the Worker cannot produce Opus at all.
//  2. ReplyOggBase64 — pre-rendered OGG/Opus (legacy / self-hosted runtimes).
//
// Neither present is a hard "say nothing": the gateway never substitutes audio
// or a voice of its own.
type TurnResponse struct {
	ReplyOggBase64 string `json:"reply_ogg_base64"`
	SpeechText     string `json:"speech_text,omitempty"`
	VoiceID        string `json:"voice_id,omitempty"`
	LanguageBoost  string `json:"language_boost,omitempty"`
	EndCall        bool   `json:"end_call"`
	Reason         string `json:"reason,omitempty"`
}

// TurnClient is the control-plane seam. Implemented by callback.TurnClient.
type TurnClient interface {
	Turn(ctx context.Context, req TurnRequest) (*TurnResponse, error)
}

// Synthesizer turns reply text into ready-to-send Opus packets. Implemented by
// tts.Speaker (MiniMax + libopus). Nil means the media plane cannot speak.
type Synthesizer interface {
	Speak(ctx context.Context, callID, text, voiceID, boost string) ([][]byte, error)
}

// SpeechTiming is the sanitized breakdown of one synthesis.
type SpeechTiming struct {
	ProviderMs int
	EncodeMs   int
}

// TimedSynthesizer is the optional instrumentation seam. Implemented by
// tts.Speaker; a plain Synthesizer keeps working unchanged.
type TimedSynthesizer interface {
	SpeakTimed(ctx context.Context, callID, text, voiceID, boost string) (packets [][]byte, providerMs int, encodeMs int, err error)
}

// ConversationConfig bounds the loop. Every value is configurable.
type ConversationConfig struct {
	VAD VADConfig
	// Greet sends an opening turn as soon as media attaches.
	Greet bool
	// MaxTurns bounds one call so a loop can never run away.
	MaxTurns int
	// TurnTimeout bounds one control-plane round trip.
	TurnTimeout time.Duration
	// FrameSamples per outbound Opus packet at 48 kHz.
	FrameSamples int
}

func (c ConversationConfig) normalized() ConversationConfig {
	c.VAD = c.VAD.normalized()
	if c.MaxTurns <= 0 {
		c.MaxTurns = 40
	}
	if c.TurnTimeout <= 0 {
		c.TurnTimeout = 20 * time.Second
	}
	if c.FrameSamples <= 0 {
		c.FrameSamples = 960
	}
	return c
}

var ErrNoTransport = errors.New("media: conversation not attached")

type ConversationPipeline struct {
	callID string
	client TurnClient
	synth  Synthesizer
	cfg    ConversationConfig
	logger *slog.Logger

	mu        sync.Mutex
	transport Transport
	seg       *Segmenter
	closed    bool
	busy      bool
	greeted   bool
	accepted  bool
	turns     int
	speaking  bool
	cancelTTS chan struct{}
	bargeIns  int

	// Instrumentation only — never influences conversational behaviour.
	now          func() time.Time
	speechEndAt  time.Time
	lastMetrics  *TurnMediaMetrics
	pendingVADMs int

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func NewConversationPipeline(callID string, client TurnClient, cfg ConversationConfig, logger *slog.Logger) *ConversationPipeline {
	if logger == nil {
		logger = slog.Default()
	}
	n := cfg.normalized()
	return &ConversationPipeline{
		callID: callID, client: client, cfg: n, logger: logger,
		seg: NewSegmenter(n.VAD), now: time.Now,
	}
}

// WithSynthesizer installs the media-plane voice. Without it the pipeline can
// only play pre-rendered OGG/Opus; it never invents a substitute voice.
func (p *ConversationPipeline) WithSynthesizer(s Synthesizer) *ConversationPipeline {
	p.synth = s
	return p
}

// WithClock overrides the instrumentation clock (tests only).
func (p *ConversationPipeline) WithClock(now func() time.Time) *ConversationPipeline {
	if now != nil {
		p.now = now
		p.seg.WithClock(now)
	}
	return p
}

// LastMetrics returns the media-plane timings of the most recently played
// turn, or nil when nothing has been played yet.
func (p *ConversationPipeline) LastMetrics() *TurnMediaMetrics {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lastMetrics == nil {
		return nil
	}
	copied := *p.lastMetrics
	return &copied
}

func (p *ConversationPipeline) clock() time.Time {
	if p.now == nil {
		return time.Now()
	}
	return p.now()
}

// Mode identifies this pipeline in diagnostics as the real-time AI loop.
func (p *ConversationPipeline) Mode() string { return ModeRealtimeAI }

func (p *ConversationPipeline) Attach(ctx context.Context, t Transport) error {
	if t == nil {
		return ErrNoTransport
	}
	p.mu.Lock()
	p.transport = t
	p.ctx, p.cancel = context.WithCancel(context.WithoutCancel(ctx))
	p.mu.Unlock()
	// NO greeting here. Attach happens while Meta has only seen the SDP answer;
	// the control plane rejects any turn before `accept` completes
	// (voice_turn_rejected reason=not_accepted) and never retries it. The
	// greeting is started exactly once by StartGreeting, which the control
	// plane triggers immediately after Meta accept succeeds.
	return nil
}

// GreetingOutcome is the safe, enumerated result of a post-accept greeting
// request. It never carries audio, transcripts or identifiers.
type GreetingOutcome string

const (
	GreetingStarted   GreetingOutcome = "started"
	GreetingDuplicate GreetingOutcome = "duplicate"
	GreetingDisabled  GreetingOutcome = "disabled"
	GreetingClosed    GreetingOutcome = "closed"
	GreetingDetached  GreetingOutcome = "detached"
)

// StartGreeting begins the opening turn exactly once per call. It is
// idempotent (duplicate control-plane notifications are no-ops) and refuses
// after Close, so a TERMINATE that races the accept notification cancels it.
func (p *ConversationPipeline) StartGreeting() GreetingOutcome {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return GreetingClosed
	}
	if p.transport == nil {
		p.mu.Unlock()
		return GreetingDetached
	}
	// Accept is recorded even when greeting is disabled: caller utterances are
	// only forwarded once Meta has accepted the call.
	p.accepted = true
	switch {
	case !p.cfg.Greet || p.client == nil:
		p.mu.Unlock()
		return GreetingDisabled
	case p.greeted:
		p.mu.Unlock()
		return GreetingDuplicate
	}
	p.greeted = true
	p.mu.Unlock()
	p.logger.Info("greeting_started", "call_id", p.callID)
	p.startTurn(TurnRequest{CallID: p.callID, Kind: TurnKindGreeting})
	return GreetingStarted
}

// Greeted reports whether the single opening turn has been started.
func (p *ConversationPipeline) Greeted() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.greeted
}

// OnInbound must never block the RTP reader.
func (p *ConversationPipeline) OnInbound(frame OpusFrame) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	event, utterance := p.seg.Push(frame)
	switch event {
	case VADSpeechStart:
		if p.speaking {
			// BARGE-IN: stop talking over the caller, immediately.
			p.stopPlaybackLocked("barge_in")
			p.bargeIns++
			p.mu.Unlock()
			p.logger.Info("barge_in", "call_id", p.callID)
			return
		}
	case VADUtteranceEnd:
		if p.busy || p.client == nil || !p.accepted || p.turns >= p.cfg.MaxTurns {
			p.mu.Unlock()
			return
		}
		durationMs := len(utterance) * p.cfg.VAD.FrameMs
		endedAt := p.clock()
		speechEnd := p.seg.SpeechEndAt()
		p.speechEndAt = speechEnd
		if !speechEnd.IsZero() {
			p.pendingVADMs = int(endedAt.Sub(speechEnd).Milliseconds())
		}
		p.mu.Unlock()
		p.startTurn(TurnRequest{
			CallID:         p.callID,
			Kind:           TurnKindUtterance,
			AudioOggBase64: base64.StdEncoding.EncodeToString(WriteOggOpus(utterance, 2, p.cfg.FrameSamples)),
			DurationMs:     durationMs,
		})
		return
	}
	p.mu.Unlock()
}

func (p *ConversationPipeline) startTurn(req TurnRequest) {
	p.mu.Lock()
	if p.closed || p.busy {
		p.mu.Unlock()
		return
	}
	p.busy = true
	p.turns++
	req.Sequence = p.turns
	metrics := TurnMediaMetrics{VADFinalizeMs: p.pendingVADMs}
	if p.lastMetrics != nil {
		metrics.PrevSequence = p.lastMetrics.PrevSequence
		metrics.TTSMs = p.lastMetrics.TTSMs
		metrics.TTSEncodeMs = p.lastMetrics.TTSEncodeMs
		metrics.PlaybackStartMs = p.lastMetrics.PlaybackStartMs
		metrics.SpeechEndToFirstAudioMs = p.lastMetrics.SpeechEndToFirstAudioMs
	}
	p.pendingVADMs = 0
	if metrics != (TurnMediaMetrics{}) {
		copied := metrics
		req.MediaMetrics = &copied
	}
	turnStartedAt := p.clock()
	speechEndAt := p.speechEndAt
	sequence := req.Sequence
	ctx := p.ctx
	// Register the turn before releasing the lifecycle lock. Close takes the
	// same lock before waiting, so it can never race Wait against a late Add.
	p.wg.Add(1)
	p.mu.Unlock()

	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		defer p.wg.Done()
		defer func() {
			p.mu.Lock()
			p.busy = false
			p.mu.Unlock()
		}()
		p.runTurn(ctx, req, turnState{startedAt: turnStartedAt, speechEndAt: speechEndAt, sequence: sequence})
	}()
}

// turnState carries the per-turn instrumentation anchors.
type turnState struct {
	startedAt   time.Time
	speechEndAt time.Time
	sequence    int
}

func (p *ConversationPipeline) runTurn(ctx context.Context, req TurnRequest, st turnState) {
	tctx, cancel := context.WithTimeout(ctx, p.cfg.TurnTimeout)
	defer cancel()

	resp, err := p.client.Turn(tctx, req)
	if err != nil {
		// FAIL CLOSED: no fabricated transcript, no fabricated audio.
		p.logger.Warn("turn_failed", "call_id", p.callID, "kind", req.Kind, "error_class", "turn")
		return
	}
	if resp == nil {
		return
	}
	switch {
	case resp.SpeechText != "":
		// PRODUCTION PATH — the media plane owns MiniMax synthesis and Opus
		// encoding, because the Worker runtime cannot produce Opus at all.
		if p.synth == nil {
			p.logger.Warn("turn_reply_no_synthesizer", "call_id", p.callID)
			break
		}
		var packets [][]byte
		var timing SpeechTiming
		var ttsErr error
		if timed, ok := p.synth.(TimedSynthesizer); ok {
			var providerMs, encodeMs int
			packets, providerMs, encodeMs, ttsErr = timed.SpeakTimed(tctx, p.callID, resp.SpeechText, resp.VoiceID, resp.LanguageBoost)
			timing = SpeechTiming{ProviderMs: providerMs, EncodeMs: encodeMs}
		} else {
			packets, ttsErr = p.synth.Speak(tctx, p.callID, resp.SpeechText, resp.VoiceID, resp.LanguageBoost)
		}
		if ttsErr != nil {
			// FAIL CLOSED: silence, never a substitute provider or voice.
			p.logger.Warn("turn_reply_tts_failed", "call_id", p.callID)
			break
		}
		firstAudioAt := p.play(packets)
		p.recordTurnMetrics(st, timing, firstAudioAt)
	case resp.ReplyOggBase64 != "":
		raw, decErr := base64.StdEncoding.DecodeString(resp.ReplyOggBase64)
		if decErr != nil {
			p.logger.Warn("turn_reply_undecodable", "call_id", p.callID)
			return
		}
		packets, parseErr := ReadOggOpus(raw)
		if parseErr != nil {
			p.logger.Warn("turn_reply_invalid_container", "call_id", p.callID)
			return
		}
		firstAudioAt := p.play(packets)
		p.recordTurnMetrics(st, SpeechTiming{}, firstAudioAt)
	}

	if resp.EndCall {
		p.mu.Lock()
		t := p.transport
		p.mu.Unlock()
		if t != nil {
			t.Terminate(orDefault(resp.Reason, "conversation_complete"))
		}
	}
}

// play streams reply packets at real time and stops the instant a barge-in,
// termination or context cancellation occurs.
func (p *ConversationPipeline) play(packets [][]byte) time.Time {
	var firstAudioAt time.Time
	if len(packets) == 0 {
		return firstAudioAt
	}
	p.mu.Lock()
	if p.closed || p.transport == nil {
		p.mu.Unlock()
		return firstAudioAt
	}
	cancelCh := make(chan struct{})
	p.cancelTTS = cancelCh
	p.speaking = true
	t := p.transport
	frameMs := p.cfg.VAD.FrameMs
	p.mu.Unlock()

	defer func() {
		p.mu.Lock()
		p.speaking = false
		if p.cancelTTS == cancelCh {
			p.cancelTTS = nil
		}
		p.mu.Unlock()
	}()

	interval := time.Duration(frameMs) * time.Millisecond
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for _, packet := range packets {
		select {
		case <-cancelCh: // barge-in: discard every remaining frame
			return firstAudioAt
		default:
		}
		if err := t.SendOpus(OpusFrame{Data: packet, Duration: interval}); err != nil {
			return firstAudioAt
		}
		if firstAudioAt.IsZero() {
			firstAudioAt = p.clock()
		}
		select {
		case <-cancelCh:
			return firstAudioAt
		case <-ticker.C:
		}
	}
	return firstAudioAt
}

// recordTurnMetrics stores the media-plane timings of the turn that just
// played. They ride along with the NEXT turn request — the gateway never
// opens a new endpoint or a second callback for telemetry.
func (p *ConversationPipeline) recordTurnMetrics(st turnState, timing SpeechTiming, firstAudioAt time.Time) {
	if firstAudioAt.IsZero() {
		return
	}
	m := &TurnMediaMetrics{
		PrevSequence: st.sequence,
		TTSMs:        timing.ProviderMs,
		TTSEncodeMs:  timing.EncodeMs,
	}
	if !st.startedAt.IsZero() {
		m.PlaybackStartMs = int(firstAudioAt.Sub(st.startedAt).Milliseconds())
	}
	if !st.speechEndAt.IsZero() {
		m.SpeechEndToFirstAudioMs = int(firstAudioAt.Sub(st.speechEndAt).Milliseconds())
	}
	p.mu.Lock()
	p.lastMetrics = m
	p.mu.Unlock()
	p.logger.Info("turn_media_timing",
		"call_id", p.callID, "sequence", st.sequence,
		"tts_ms", m.TTSMs, "tts_encode_ms", m.TTSEncodeMs,
		"playback_start_ms", m.PlaybackStartMs,
		"speech_end_to_first_audio_ms", m.SpeechEndToFirstAudioMs)
}

func (p *ConversationPipeline) stopPlaybackLocked(_ string) {
	if p.cancelTTS != nil {
		close(p.cancelTTS)
		p.cancelTTS = nil
	}
	p.speaking = false
}

// Speaking reports whether outbound TTS playback is currently running.
func (p *ConversationPipeline) Speaking() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.speaking
}

// BargeIns is the number of caller interruptions handled on this call.
func (p *ConversationPipeline) BargeIns() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.bargeIns
}

// Turns is the number of control-plane turns started on this call.
func (p *ConversationPipeline) Turns() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.turns
}

// Close is called exactly once per session by the media layer.
func (p *ConversationPipeline) Close(reason string) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.stopPlaybackLocked(reason)
	p.seg.Reset()
	cancel := p.cancel
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	p.wg.Wait()
}

func orDefault(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
