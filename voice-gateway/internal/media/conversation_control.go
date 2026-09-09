package media

// Conversation scheduling only. The transport, codec and MiniMax adapter are unchanged.
import (
	"context"
	"sync"
	"time"

	pion "github.com/pion/webrtc/v4"
)

// Observe the existing transport state without changing WebRTC or waiting for
// OnTrack/inbound speech. Non-WebRTC transports retain their existing contract.
func (p *ConversationPipeline) waitForConversationReady(ctx context.Context) bool {
	p.mu.Lock()
	transport := p.transport
	p.mu.Unlock()
	state, ok := transport.(interface {
		ConnectionState() pion.PeerConnectionState
	})
	if ok {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for state.ConnectionState() != pion.PeerConnectionStateConnected {
			switch state.ConnectionState() {
			case pion.PeerConnectionStateFailed, pion.PeerConnectionStateClosed:
				return false
			}
			select {
			case <-ctx.Done():
				return false
			case <-tick.C:
			}
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || !p.accepted || ctx.Err() != nil {
		return false
	}
	p.connectedAt = p.clock()
	return true
}

func ackKey(r TurnResponse) string {
	return r.VoiceID + "\x00" + r.LanguageBoost + "\x00" + r.SpeechText
}

// Three short, control-plane-selected phrases, scoped to this call's lifetime.
// Render during the greeting using the same existing MiniMax/Opus synthesizer.
func (p *ConversationPipeline) prepareBackchannels(r *TurnResponse) {
	if p.synth == nil || len(r.BackchannelTexts) == 0 {
		return
	}
	texts := append([]string(nil), r.BackchannelTexts...)
	if len(texts) > 3 {
		texts = texts[:3]
	}
	p.mu.Lock()
	if p.closed || p.ackCache != nil {
		p.mu.Unlock()
		return
	}
	p.ackCache = make(map[string][][]byte)
	ctx := p.ctx
	p.wg.Add(1)
	p.mu.Unlock()
	go func() {
		defer p.wg.Done()
		ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
		defer cancel()
		for _, text := range texts {
			if len(text) == 0 || len(text) > 140 || ctx.Err() != nil {
				continue
			}
			packets, err := p.synth.Speak(ctx, p.callID, text, r.VoiceID, r.LanguageBoost)
			if err != nil || len(packets) == 0 || len(packets) > 250 {
				continue
			}
			p.mu.Lock()
			if !p.closed {
				p.ackCache[ackKey(TurnResponse{SpeechText: text, VoiceID: r.VoiceID, LanguageBoost: r.LanguageBoost})] = packets
			}
			p.mu.Unlock()
		}
	}()
}

func (p *ConversationPipeline) requestWithBackchannel(ctx context.Context, req TurnRequest, st turnState) (*TurnResponse, time.Time, error) {
	client, streaming := p.client.(StreamingTurnClient)
	if !streaming {
		r, e := p.client.Turn(ctx, req)
		return r, time.Time{}, e
	}
	var mu sync.Mutex
	var once sync.Once
	final, playing, received := false, false, false
	var first time.Time
	done := make(chan struct{})
	ackCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	onAck := func(ack TurnResponse) {
		if req.Kind != TurnKindUtterance || p.synth == nil || ack.SpeechText == "" || len(ack.SpeechText) > 140 || ack.EndCall {
			return
		}
		once.Do(func() {
			received = true // callback is synchronous in the single response reader
			go func() {
				defer close(done)
				p.mu.Lock()
				packets := p.ackCache[ackKey(ack)]
				p.mu.Unlock()
				if len(packets) == 0 {
					var err error
					packets, err = p.synth.Speak(ackCtx, p.callID, ack.SpeechText, ack.VoiceID, ack.LanguageBoost)
					if err != nil || len(packets) > 250 {
						return
					}
				}
				mu.Lock()
				if final || ackCtx.Err() != nil {
					mu.Unlock()
					return
				}
				playing = true
				mu.Unlock()
				first, _ = p.playTurn(ackCtx, packets, st.generation)
			}()
		})
	}
	response, err := client.TurnStream(ctx, req, onAck)
	mu.Lock()
	final = true
	if !playing || err != nil {
		cancel()
	}
	mu.Unlock()
	if received {
		<-done
	}
	return response, first, err
}

func (p *ConversationPipeline) recordConversationMetrics(st turnState, kind string, ack, first time.Time, complete bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lastMetrics == nil || p.lastMetrics.PrevSequence != st.sequence {
		return
	}
	m := p.lastMetrics
	if !ack.IsZero() && !st.speechEndAt.IsZero() {
		m.AcknowledgementFirstAudioMs = int(ack.Sub(st.speechEndAt).Milliseconds())
	}
	if complete {
		m.PlaybackCompleteMs = int(p.clock().Sub(st.startedAt).Milliseconds())
	}
	if kind == TurnKindGreeting && !first.IsZero() {
		if !p.acceptedAt.IsZero() {
			m.AcceptedToGreetingMs = int(first.Sub(p.acceptedAt).Milliseconds())
		}
		if !p.connectedAt.IsZero() {
			m.ReadyToGreetingMs = int(first.Sub(p.connectedAt).Milliseconds())
		}
	}
	p.logger.Info("conversation_audio_timing", "call_id", p.callID, "sequence", st.sequence,
		"acknowledgement_first_audio_ms", m.AcknowledgementFirstAudioMs,
		"substantive_first_audio_ms", m.SpeechEndToFirstAudioMs, "playback_complete_ms", m.PlaybackCompleteMs,
		"accepted_to_greeting_ms", m.AcceptedToGreetingMs, "ready_to_greeting_ms", m.ReadyToGreetingMs)
}
