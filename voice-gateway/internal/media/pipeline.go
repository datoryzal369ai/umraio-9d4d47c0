// Package media defines the transport-agnostic audio abstraction that sits
// between the WebRTC plane and a future ASR/TTS pipeline. No provider is wired
// in here on purpose: Phase 1 ships the interfaces only.
package media

import (
	"context"
	"errors"
	"time"
)

// OpusFrame is one encoded Opus packet lifted off (or destined for) RTP.
// Data is never logged.
type OpusFrame struct {
	Data      []byte
	Duration  time.Duration
	Sequence  uint16
	Timestamp uint32
}

// Transport is what the WebRTC layer offers to a pipeline: a way to push audio
// back to the caller and a way to end the media session.
type Transport interface {
	SendOpus(frame OpusFrame) error
	Terminate(reason string)
}

// Pipeline consumes caller audio and may produce reply audio through the
// Transport it is attached to. The real implementation (streaming ASR ->
// RENAIO.CORE -> TTS) lands in a later phase and lives behind this interface.
type Pipeline interface {
	Attach(ctx context.Context, t Transport) error
	// OnInbound receives decodable caller audio. Implementations must be
	// non-blocking; heavy work belongs on their own goroutine.
	OnInbound(frame OpusFrame)
	// Close releases pipeline resources. Called exactly once per session.
	Close(reason string)
}

// ErrNotAttached is returned by transports used before negotiation completes.
var ErrNotAttached = errors.New("media: transport not attached")

// NoopPipeline is the Phase 1 default: it counts frames and does nothing else.
// It exists so the media plane is fully exercisable without any AI provider.
type NoopPipeline struct {
	inbound int64
}

func (p *NoopPipeline) Attach(context.Context, Transport) error { return nil }
func (p *NoopPipeline) OnInbound(OpusFrame)                     { p.inbound++ }
func (p *NoopPipeline) Close(string)                            {}
func (p *NoopPipeline) InboundFrames() int64                    { return p.inbound }
