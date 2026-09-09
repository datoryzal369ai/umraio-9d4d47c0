package media

import (
	"context"
	"testing"
	"testing/synctest"
	"time"
)

type playbackPreparationClient struct {
	delay time.Duration
	end   bool
}

func (c playbackPreparationClient) Turn(ctx context.Context, req TurnRequest) (*TurnResponse, error) {
	if req.Kind == TurnKindGreeting {
		return &TurnResponse{}, nil
	}
	select {
	case <-time.After(c.delay):
		return &TurnResponse{SpeechText: "synthetic reply", EndCall: c.end}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

type playbackPreparationSynth struct {
	provider, encode time.Duration
	packets          int
	ignoreDeadline   bool // model preparation returning late; admission must reject it
}

func (s playbackPreparationSynth) Speak(ctx context.Context, _, _, _, _ string) ([][]byte, error) {
	if s.ignoreDeadline {
		time.Sleep(s.provider + s.encode)
	} else {
		select {
		case <-time.After(s.provider + s.encode):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	packets := make([][]byte, s.packets)
	for i := range packets {
		packets[i] = []byte{0xf8, 0xff, 0xfe} // valid Opus silence; no provider calls
	}
	return packets, nil
}

func (s playbackPreparationSynth) SpeakTimed(ctx context.Context, callID, text, voice, boost string) ([][]byte, int, int, error) {
	packets, err := s.Speak(ctx, callID, text, voice, boost)
	return packets, int(s.provider.Milliseconds()), int(s.encode.Milliseconds()), err
}

// synctest advances a virtual clock, so the real Founder durations are tested
// exactly without wall-clock sleeps or weakening the original 20s budget.
func founderPlayback(t *testing.T, end bool) (*ConversationPipeline, *candidateTransport, time.Time) {
	t.Helper()
	cfg := ConversationConfig{Greet: true, TurnTimeout: 20 * time.Second}
	// Worker 4470ms + observed preparation/transport residual 365ms; synthesis
	// 4260ms + encode 178ms => playback +9273ms from turn dispatch, 606*20ms long.
	p := NewConversationPipeline("synthetic-founder-seq2", playbackPreparationClient{4835 * time.Millisecond, end}, cfg, nil)
	p.WithSynthesizer(playbackPreparationSynth{4260 * time.Millisecond, 178 * time.Millisecond, 606, false})
	tr := &candidateTransport{pipeline: p, ended: make(chan struct{})}
	tr.connected.Store(true)
	if err := p.Attach(context.Background(), tr); err != nil {
		t.Fatal(err)
	}
	p.StartGreeting()
	synctest.Wait() // empty opening completes; replay is sequence 2
	start := time.Now()
	p.mu.Lock()
	p.speechEndAt = start.Add(-699 * time.Millisecond)
	p.mu.Unlock()
	p.startTurn(TurnRequest{Kind: TurnKindUtterance})
	return p, tr, start
}

func TestPlaybackLifecycleFounderSequenceSurvivesProcessingDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, tr, start := founderPlayback(t, true)
		defer p.Close("test")
		time.Sleep(9273 * time.Millisecond)
		synctest.Wait()
		if tr.count() != 1 || !p.Speaking() {
			t.Fatalf("expected first frame at +9273ms, got %d", tr.count())
		}
		time.Sleep(20*time.Second - time.Since(start))
		synctest.Wait()
		if !p.busyNow() || !p.Speaking() || len(tr.reasons()) != 0 {
			t.Fatal("valid playback cancelled at the original processing deadline")
		}
		before := tr.count()
		<-tr.ended // termination waits for all frames AND active-turn ownership
		if tr.count() != 606 || before >= tr.count() || time.Since(start) != 21393*time.Millisecond {
			t.Fatalf("clipped/incorrect playback: packets=%d duration=%v", tr.count(), time.Since(start))
		}
		if len(tr.reasons()) != 1 || tr.reasons()[0] != "conversation_complete" {
			t.Fatalf("natural termination changed: %v", tr.reasons())
		}
		m := p.LastMetrics()
		if m == nil || m.PrevSequence != 2 || m.SpeechEndToFirstAudioMs != 9972 || m.PlaybackCompleteMs != 21393 || m.TTSMs != 4260 || m.TTSEncodeMs != 178 {
			t.Fatalf("Founder timeline/complete telemetry wrong: %+v", m)
		}
		p.wg.Wait() // synctest also fails any leaked goroutine/deadlock
	})
}

func TestPlaybackLifecycleCallerQuietWaitKeepsPreparationDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, tr := newPipeline(t, playbackPreparationClient{}, ConversationConfig{TurnTimeout: 20 * time.Second})
		p.WithSynthesizer(playbackPreparationSynth{packets: 10})
		defer p.Close("test")
		p.mu.Lock()
		p.callerQuiet = make(chan struct{}) // a forced boundary has not become a true end-of-turn
		p.mu.Unlock()
		start := time.Now()
		p.startTurn(TurnRequest{Kind: TurnKindUtterance})
		p.wg.Wait()
		if tr.count() != 0 || p.busyNow() || time.Since(start) != 20*time.Second {
			t.Fatal("pre-playback caller-quiet wait lost its preparation bound")
		}
	})
}

func TestPlaybackLifecycleOrdinaryReplyCompletesWithoutTerminating(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, tr, start := founderPlayback(t, false)
		defer p.Close("test")
		p.wg.Wait()
		if tr.count() != 606 || p.busyNow() || p.Speaking() || len(tr.reasons()) != 0 || time.Since(start) != 21393*time.Millisecond {
			t.Fatal("ordinary reply clipped, leaked ownership or terminated the live conversation")
		}
	})
}

func TestPlaybackLifecyclePreparationCancellationPreventsHandoff(t *testing.T) {
	for _, cause := range []string{"barge_in", "teardown"} {
		t.Run(cause, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				p, tr, _ := founderPlayback(t, false)
				defer p.Close("test")
				time.Sleep(5 * time.Second) // synthesis is in flight, no playable packets yet
				synctest.Wait()
				if cause == "barge_in" {
					pushSpeech(p, p.cfg.VAD.StartFrames)
				} else {
					p.Close("caller_terminated")
				}
				p.wg.Wait()
				if tr.count() != 0 || p.busyNow() {
					t.Fatal("cancelled preparation reached playback or leaked turn ownership")
				}
			})
		})
	}
}

func TestPlaybackLifecycleCancellationAfterProcessingDeadline(t *testing.T) {
	for _, cause := range []string{"barge_in", "caller_teardown", "explicit_termination", "session_cancel", "media_failure"} {
		t.Run(cause, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				p, tr, _ := founderPlayback(t, true)
				defer p.Close("test")
				time.Sleep(20200 * time.Millisecond)
				synctest.Wait()
				if !p.Speaking() {
					t.Fatal("playback did not survive preparation deadline")
				}
				before := tr.count()
				switch cause {
				case "barge_in":
					pushSpeech(p, p.cfg.VAD.StartFrames)
				case "caller_teardown", "explicit_termination":
					p.Close(cause)
				case "session_cancel":
					p.cancel()
				case "media_failure":
					tr.mu.Lock()
					tr.failAfter = before
					tr.mu.Unlock()
				}
				p.wg.Wait()
				if p.Speaking() || p.busyNow() || tr.count() != before || len(tr.reasons()) != 0 {
					t.Fatalf("cancel failed or incomplete farewell hung up: count=%d before=%d", tr.count(), before)
				}
				if cause == "barge_in" && p.BargeIns() != 1 {
					t.Fatal("genuine caller barge-in not retained")
				}
			})
		})
	}
}

func TestPlaybackLifecyclePreparationStillBounded(t *testing.T) {
	for _, stage := range []string{"worker", "tts", "late_encoding"} {
		t.Run(stage, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				client := playbackPreparationClient{}
				synth := playbackPreparationSynth{packets: 10}
				switch stage {
				case "worker":
					client.delay = 21 * time.Second
				case "tts":
					synth.provider = 21 * time.Second
				case "late_encoding":
					synth.encode, synth.ignoreDeadline = 21*time.Second, true
				}
				p, tr := newPipeline(t, client, ConversationConfig{TurnTimeout: 20 * time.Second})
				p.WithSynthesizer(synth)
				defer p.Close("test")
				p.startTurn(TurnRequest{Kind: TurnKindUtterance})
				p.wg.Wait()
				if tr.count() != 0 || p.busyNow() {
					t.Fatal("expired preparation was admitted to playback")
				}
			})
		})
	}
}
