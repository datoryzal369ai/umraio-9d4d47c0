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
}

// TurnResponse is the control plane's answer. Absent audio is a hard "say
// nothing" — the gateway never substitutes audio of its own.
type TurnResponse struct {
	ReplyOggBase64 string `json:"reply_ogg_base64"`
	EndCall        bool   `json:"end_call"`
	Reason         string `json:"reason,omitempty"`
}

// TurnClient is the control-plane seam. Implemented by callback.TurnClient.
type TurnClient interface {
	Turn(ctx context.Context, req TurnRequest) (*TurnResponse, error)
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
	cfg    ConversationConfig
	logger *slog.Logger

	mu        sync.Mutex
	transport Transport
	seg       *Segmenter
	closed    bool
	busy      bool
	turns     int
	speaking  bool
	cancelTTS chan struct{}
	bargeIns  int

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
		seg: NewSegmenter(n.VAD),
	}
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
	greet := p.cfg.Greet && p.client != nil
	p.mu.Unlock()

	if greet {
		p.startTurn(TurnRequest{CallID: p.callID, Kind: TurnKindGreeting})
	}
	return nil
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
		if p.busy || p.client == nil || p.turns >= p.cfg.MaxTurns {
			p.mu.Unlock()
			return
		}
		durationMs := len(utterance) * p.cfg.VAD.FrameMs
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
	ctx := p.ctx
	p.mu.Unlock()

	if ctx == nil {
		ctx = context.Background()
	}
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer func() {
			p.mu.Lock()
			p.busy = false
			p.mu.Unlock()
		}()
		p.runTurn(ctx, req)
	}()
}

func (p *ConversationPipeline) runTurn(ctx context.Context, req TurnRequest) {
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
	if resp.ReplyOggBase64 != "" {
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
		p.play(packets)
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
func (p *ConversationPipeline) play(packets [][]byte) {
	if len(packets) == 0 {
		return
	}
	p.mu.Lock()
	if p.closed || p.transport == nil {
		p.mu.Unlock()
		return
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
			return
		default:
		}
		if err := t.SendOpus(OpusFrame{Data: packet, Duration: interval}); err != nil {
			return
		}
		select {
		case <-cancelCh:
			return
		case <-ticker.C:
		}
	}
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
