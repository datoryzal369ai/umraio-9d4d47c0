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
	SpeechEndToFirstAudioMs     int `json:"speech_end_to_first_audio_ms,omitempty"`
	AcknowledgementFirstAudioMs int `json:"acknowledgement_first_audio_ms,omitempty"`
	PlaybackCompleteMs          int `json:"playback_complete_ms,omitempty"`
	AcceptedToGreetingMs        int `json:"accepted_to_greeting_ms,omitempty"`
	ReadyToGreetingMs           int `json:"ready_to_greeting_ms,omitempty"`
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
	ReplyOggBase64   string   `json:"reply_ogg_base64"`
	SpeechText       string   `json:"speech_text,omitempty"`
	VoiceID          string   `json:"voice_id,omitempty"`
	LanguageBoost    string   `json:"language_boost,omitempty"`
	EndCall          bool     `json:"end_call"`
	Reason           string   `json:"reason,omitempty"`
	BackchannelTexts []string `json:"backchannel_texts,omitempty"`
}

// TurnClient is the control-plane seam. Implemented by callback.TurnClient.
type StreamingTurnClient interface {
	TurnStream(ctx context.Context, req TurnRequest, onAck func(TurnResponse)) (*TurnResponse, error)
}

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
	// TurnTimeout bounds control-plane and speech preparation, not ready audio.
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

	mu          sync.Mutex
	transport   Transport
	seg         *Segmenter
	closed      bool
	busy        bool
	greeted     bool
	accepted    bool
	acceptedAt  time.Time
	connectedAt time.Time
	generation  uint64
	pending     []pendingTurn
	cancelTurn  context.CancelFunc
	ending      bool
	ackCache    map[string][][]byte
	turns       int
	// A size-limited VAD segment is not a conversational end-of-speech.
	// Keep caller ownership across resets until the existing silence threshold.
	callerQuiet chan struct{}
	// Provisional activity pauses speech eligibility, not request ownership.
	provisionalQuiet chan struct{}
	silenceMs        int
	speaking         bool
	cancelTTS        chan struct{}
	bargeIns         int

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
	if !p.accepted {
		p.acceptedAt = p.clock()
	}
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
	if p.closed || p.ending {
		p.mu.Unlock()
		return
	}
	if len(frame.Data) >= p.cfg.VAD.SpeechMinBytes {
		p.silenceMs = 0
	} else if p.silenceMs < p.cfg.VAD.EndSilenceMs {
		p.silenceMs += p.cfg.VAD.FrameMs
	}
	if p.callerQuiet != nil && p.silenceMs >= p.cfg.VAD.EndSilenceMs {
		close(p.callerQuiet)
		p.callerQuiet = nil
	}
	wasQualified := p.seg.Qualified()
	event, utterance := p.seg.Push(frame)
	// A qualifying frame can also hit the maximum segment boundary. An
	// accepted final segment proves qualification even after Segmenter reset.
	qualifiedNow := !wasQualified && (p.seg.Qualified() || event == VADUtteranceEnd)
	if event == VADSpeechStart && !qualifiedNow && p.provisionalQuiet == nil {
		p.provisionalQuiet = make(chan struct{})
	}
	if qualifiedNow {
		p.generation++
		if p.cancelTurn != nil {
			p.cancelTurn()
		}
		if p.speaking {
			// Qualified interruption: retire playback and stale work once.
			p.stopPlaybackLocked("barge_in")
			p.bargeIns++
			p.logger.Info("barge_in", "call_id", p.callID)
		}
	}
	if (qualifiedNow || event == VADDiscarded || event == VADUtteranceEnd) && p.provisionalQuiet != nil {
		close(p.provisionalQuiet)
		p.provisionalQuiet = nil
	}
	switch event {
	case VADUtteranceEnd:
		if p.client == nil || !p.accepted || p.turns >= p.cfg.MaxTurns {
			p.mu.Unlock()
			return
		}
		durationMs := len(utterance) * p.cfg.VAD.FrameMs
		forced := durationMs >= p.cfg.VAD.MaxUtteranceMs && p.silenceMs < p.cfg.VAD.EndSilenceMs
		deferDispatch := forced && p.callerQuiet != nil
		if forced && p.callerQuiet == nil {
			p.callerQuiet = make(chan struct{})
		}
		endedAt := p.clock()
		speechEnd := p.seg.SpeechEndAt()
		p.speechEndAt = speechEnd
		if !speechEnd.IsZero() {
			p.pendingVADMs = int(endedAt.Sub(speechEnd).Milliseconds())
		}
		p.mu.Unlock()
		p.submitTurn(TurnRequest{
			CallID:         p.callID,
			Kind:           TurnKindUtterance,
			AudioOggBase64: base64.StdEncoding.EncodeToString(WriteOggOpus(utterance, 2, p.cfg.FrameSamples)),
			DurationMs:     durationMs,
		}, deferDispatch)
		return
	}
	p.startPendingTurnLocked()
	p.mu.Unlock()
}

type pendingTurn struct {
	request     TurnRequest
	speechEndAt time.Time
	generation  uint64
	vadMs       int
}

func (p *ConversationPipeline) startTurn(req TurnRequest) {
	p.submitTurn(req, false)
}

func (p *ConversationPipeline) submitTurn(req TurnRequest, deferDispatch bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.ending {
		return
	}
	next := pendingTurn{req, p.speechEndAt, p.generation, p.pendingVADMs}
	p.pendingVADMs = 0
	if deferDispatch || p.busy || len(p.pending) > 0 {
		// Bound caller buffering without starting concurrent control-plane turns.
		if len(p.pending) < 4 {
			p.pending = append(p.pending, next)
		}
		p.startPendingTurnLocked()
		return
	}
	p.startTurnLocked(next)
}

func (p *ConversationPipeline) startPendingTurnLocked() {
	if p.closed || p.ending || p.busy || p.callerQuiet != nil || len(p.pending) == 0 {
		return
	}
	queued := p.pending[0]
	p.pending = p.pending[1:]
	p.startTurnLocked(queued)
}

// Caller holds mu: Add cannot race Close/Wait.
func (p *ConversationPipeline) startTurnLocked(next pendingTurn) {
	if p.closed || p.ending || p.turns >= p.cfg.MaxTurns {
		return
	}
	p.busy = true
	p.turns++
	req := next.request
	req.Sequence = p.turns
	metrics := TurnMediaMetrics{}
	if p.lastMetrics != nil {
		metrics = *p.lastMetrics
	}
	metrics.VADFinalizeMs = next.vadMs
	if metrics != (TurnMediaMetrics{}) {
		req.MediaMetrics = &metrics
	}
	parent := p.ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	p.cancelTurn = cancel
	st := turnState{startedAt: p.clock(), speechEndAt: next.speechEndAt, sequence: req.Sequence, generation: next.generation}
	p.wg.Add(1)
	go func() {
		reason := p.runTurn(ctx, req, st)
		cancel()
		p.mu.Lock()
		p.busy = false
		p.cancelTurn = nil
		transport := p.transport
		// A caller may resume between the last farewell frame and this lock.
		// Commit termination only while the same completed turn is current.
		if reason != "" && (p.closed || p.generation != st.generation || p.seg.Speaking() || p.callerQuiet != nil) {
			reason = ""
		}
		if reason != "" && !p.closed {
			p.ending = true
			p.pending = nil
		} else {
			p.startPendingTurnLocked()
		}
		p.mu.Unlock()
		// Transport.Terminate calls Close/Wait. This turn must leave the
		// wait group FIRST, otherwise a natural hangup waits on itself.
		p.wg.Done()
		if reason != "" && transport != nil {
			transport.Terminate(reason)
		}
	}()
}

// turnState carries the per-turn instrumentation anchors.
type turnState struct {
	startedAt   time.Time
	speechEndAt time.Time
	sequence    int
	generation  uint64
}

func (p *ConversationPipeline) runTurn(ctx context.Context, req TurnRequest, st turnState) string {
	tctx, cancel := context.WithTimeout(ctx, p.cfg.TurnTimeout)
	defer cancel()
	if req.Kind == TurnKindGreeting && !p.waitForConversationReady(tctx) {
		return ""
	}

	resp, ackAt, err := p.requestWithBackchannel(tctx, req, st)
	if err != nil {
		p.logger.Warn("turn_failed", "call_id", p.callID, "kind", req.Kind, "error_class", "turn")
		return ""
	}
	if resp == nil || tctx.Err() != nil {
		return ""
	}
	var packets [][]byte
	var timing SpeechTiming
	switch {
	case resp.SpeechText != "":
		if p.synth == nil {
			return ""
		}
		if timed, ok := p.synth.(TimedSynthesizer); ok {
			var providerMs, encodeMs int
			packets, providerMs, encodeMs, err = timed.SpeakTimed(tctx, p.callID, resp.SpeechText, resp.VoiceID, resp.LanguageBoost)
			timing = SpeechTiming{ProviderMs: providerMs, EncodeMs: encodeMs}
		} else {
			packets, err = p.synth.Speak(tctx, p.callID, resp.SpeechText, resp.VoiceID, resp.LanguageBoost)
		}
		if err != nil {
			p.logger.Warn("turn_reply_tts_failed", "call_id", p.callID)
			return ""
		}
	case resp.ReplyOggBase64 != "":
		var raw []byte
		raw, err = base64.StdEncoding.DecodeString(resp.ReplyOggBase64)
		if err != nil {
			return ""
		}
		packets, err = ReadOggOpus(raw)
		if err != nil {
			return ""
		}
	default:
		// Preserve the legacy explicit audio-free control termination command.
		if resp.EndCall {
			return orDefault(resp.Reason, "conversation_complete")
		}
		return ""
	}
	// Admit only prepared, current audio while the processing budget is valid.
	// Waiting for caller silence is still preparation, not detached playback.
	if len(packets) == 0 || !p.waitForSpeechEligibility(tctx, st.generation) || tctx.Err() != nil {
		return ""
	}
	// Playback belongs to the live turn/session, not its spent processing
	// budget. Keep a finite bound: audio duration plus one processing budget
	// of scheduling allowance. Barge-in and teardown still cancel ctx.
	playbackBudget := time.Duration(len(packets))*time.Duration(p.cfg.VAD.FrameMs)*time.Millisecond + p.cfg.TurnTimeout
	playbackCtx, stopPlayback := context.WithTimeout(ctx, playbackBudget)
	defer stopPlayback()
	cancel()
	if req.Kind == TurnKindGreeting {
		p.prepareBackchannels(resp)
	}
	firstAudioAt, complete := p.playTurn(playbackCtx, packets, st.generation)
	p.recordTurnMetrics(st, timing, firstAudioAt)
	p.recordConversationMetrics(st, req.Kind, ackAt, firstAudioAt, complete)
	if resp.EndCall && complete && playbackCtx.Err() == nil {
		return orDefault(resp.Reason, "conversation_complete")
	}
	return ""
}

// Pending work survives provisional activity under its existing deadline.
// A rejected segment reopens eligibility; qualification invalidates generation.
func (p *ConversationPipeline) waitForSpeechEligibility(ctx context.Context, generation uint64) bool {
	if !p.waitForCallerQuiet(ctx, generation) {
		return false
	}
	for {
		p.mu.Lock()
		valid := !p.closed && p.generation == generation && ctx.Err() == nil
		quiet := p.provisionalQuiet
		p.mu.Unlock()
		if !valid || quiet == nil {
			return valid
		}
		select {
		case <-ctx.Done():
			return false
		case <-quiet:
		}
	}
}

// play streams reply packets at real time and stops the instant a qualified barge-in,
// termination or context cancellation occurs.
func (p *ConversationPipeline) playTurn(ctx context.Context, packets [][]byte, generation uint64) (time.Time, bool) {
	var firstAudioAt time.Time
	if len(packets) == 0 {
		return firstAudioAt, false
	}
	for {
		if !p.waitForSpeechEligibility(ctx, generation) {
			return firstAudioAt, false
		}
		p.mu.Lock()
		if p.provisionalQuiet != nil { // activity raced the eligibility check
			p.mu.Unlock()
			continue
		}
		if p.closed || p.transport == nil || p.seg.Speaking() || p.generation != generation || ctx.Err() != nil {
			p.mu.Unlock()
			return firstAudioAt, false
		}
		break // hold mu until playback ownership is installed
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
		waitStarted := time.Now()
		if !p.waitForSpeechEligibility(ctx, generation) {
			return firstAudioAt, false
		}
		if time.Since(waitStarted) >= interval {
			// A provisional pause must not release an overdue tick and burst
			// consecutive packets when the retained playback resumes.
			ticker.Reset(interval)
		}
		select {
		case <-ctx.Done():
			return firstAudioAt, false
		case <-cancelCh: // barge-in: discard every remaining frame
			return firstAudioAt, false
		default:
		}
		if err := t.SendOpus(OpusFrame{Data: packet, Duration: interval}); err != nil {
			return firstAudioAt, false
		}
		if firstAudioAt.IsZero() {
			firstAudioAt = p.clock()
		}
		select {
		case <-ctx.Done():
			return firstAudioAt, false
		case <-cancelCh:
			return firstAudioAt, false
		case <-ticker.C:
		}
	}
	return firstAudioAt, p.waitForSpeechEligibility(ctx, generation)
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
	p.pending = nil
	p.ackCache = nil
	p.stopPlaybackLocked(reason)
	p.seg.Reset()
	if p.provisionalQuiet != nil {
		close(p.provisionalQuiet)
		p.provisionalQuiet = nil
	}
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
