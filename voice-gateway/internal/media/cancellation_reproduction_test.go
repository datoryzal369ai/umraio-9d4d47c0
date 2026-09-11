package media

// Characterization of the unchanged b5c9f4e gateway. Synthetic packet sizes
// exercise the existing heuristic; they are not a recording of Founder audio.
// The Safety test deliberately retains the unmet no-false-cancellation gate.
import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

type cancellationAttempt struct {
	req     TurnRequest
	ctx     context.Context
	started time.Time
	release chan struct{}
	done    chan struct{}
	err     error
}

type cancellationWorker struct {
	mu       sync.Mutex
	attempts map[int]*cancellationAttempt
}

func (w *cancellationWorker) Turn(ctx context.Context, req TurnRequest) (*TurnResponse, error) {
	a := &cancellationAttempt{req: req, ctx: ctx, started: time.Now(), release: make(chan struct{}), done: make(chan struct{})}
	w.mu.Lock()
	w.attempts[req.Sequence] = a
	w.mu.Unlock()
	defer close(a.done)
	if req.Kind == TurnKindGreeting {
		return &TurnResponse{ReplyOggBase64: oggReply(500)}, nil
	}
	select {
	case <-ctx.Done():
		a.err = ctx.Err()
		return nil, a.err
	case <-a.release:
		return &TurnResponse{ReplyOggBase64: oggReply(4)}, nil
	}
}

func (w *cancellationWorker) TurnStream(ctx context.Context, req TurnRequest, _ func(TurnResponse)) (*TurnResponse, error) {
	return w.Turn(ctx, req)
}

func (w *cancellationWorker) attempt(t *testing.T, sequence int) *cancellationAttempt {
	t.Helper()
	synctest.Wait()
	w.mu.Lock()
	defer w.mu.Unlock()
	a := w.attempts[sequence]
	if a == nil {
		t.Fatalf("sequence %d was not dispatched", sequence)
	}
	return a
}

func cancellationPipeline(t *testing.T, cfg ConversationConfig) (*ConversationPipeline, *cancellationWorker, *fakeTransport) {
	t.Helper()
	w := &cancellationWorker{attempts: make(map[int]*cancellationAttempt)}
	p := NewConversationPipeline("synthetic-cancellation-only", w, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	tr := &fakeTransport{}
	if err := p.Attach(context.Background(), tr); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close("test_cleanup") })
	p.StartGreeting()
	synctest.Wait()
	return p, w, tr
}

// Virtual packet cadence, not sleeps to hide races. synctest owns all timers.
func cancellationFrames(p *ConversationPipeline, count, bytes int) {
	for i := 0; i < count; i++ {
		time.Sleep(20 * time.Millisecond)
		p.OnInbound(OpusFrame{Data: make([]byte, bytes), Duration: 20 * time.Millisecond})
	}
	synctest.Wait()
}

func cancellationPending(t *testing.T, cfg ConversationConfig) (*ConversationPipeline, *cancellationWorker, *fakeTransport, *cancellationAttempt) {
	t.Helper()
	p, w, tr := cancellationPipeline(t, cfg)
	cancellationFrames(p, 25, 120) // 500ms caller speech, valid with either minimum.
	cancellationFrames(p, 35, 3)   // exact 700ms end-silence threshold.
	return p, w, tr, w.attempt(t, 1)
}

func TestCancellationCharacterizesProductionThresholds(t *testing.T) {
	p := NewConversationPipeline("synthetic", nil, ConversationConfig{Greet: true}, nil)
	v := p.cfg.VAD
	if v.FrameMs != 20 || v.SpeechMinBytes != 40 || v.StartFrames != 3 || v.EndSilenceMs != 700 || v.MaxUtteranceMs != 15000 {
		t.Fatalf("production thresholds changed: %+v", v)
	}
	if v.MinUtteranceMs != 0 || DefaultVADConfig().MinUtteranceMs != 320 {
		t.Fatal("expected baseline zero-config versus explicit-default minimum discrepancy")
	}
	if p.cfg.TurnTimeout != 20*time.Second || p.cfg.MaxTurns != 40 {
		t.Fatal("production request/turn bounds changed")
	}
	for _, tc := range []struct {
		name      string
		sizes     []int
		cancelled bool
	}{
		{"below_threshold", []int{39, 39, 39, 39}, false},
		{"one_frame", []int{40}, false},
		{"two_frames", []int{40, 40}, false},
		{"nonconsecutive_frames", []int{40, 39, 40, 39, 40}, false},
		{"third_frame_only", []int{40, 40, 40}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				p, _, _, a := cancellationPending(t, ConversationConfig{})
				before := p.generation
				for _, size := range tc.sizes {
					cancellationFrames(p, 1, size)
				}
				if (a.ctx.Err() != nil) != tc.cancelled {
					t.Fatalf("cancellation=%v, want %v", a.ctx.Err(), tc.cancelled)
				}
				if tc.cancelled {
					<-a.done
					if !errors.Is(a.err, context.Canceled) || !p.seg.Speaking() || p.Turns() != 1 || p.generation != before+1 {
						t.Fatal("third-frame cancellation must precede finalization/new sequence")
					}
				}
			})
		})
	}
}

func TestCancellationCharacterizesDiscardedPulseStillDestroysPendingResponse(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, _, tr, a := cancellationPending(t, ConversationConfig{VAD: DefaultVADConfig()})
		before := p.generation
		cancellationFrames(p, 3, 40) // 60ms, much shorter than explicit 320ms minimum.
		<-a.done
		if !errors.Is(a.err, context.Canceled) || !p.seg.Speaking() {
			t.Fatal("baseline cancellation not reproduced")
		}
		cancellationFrames(p, 35, 3)
		if p.seg.Speaking() || p.Turns() != 1 || p.busyNow() || p.generation != before+1 || tr.count() != 0 {
			t.Fatal("discarded pulse must leave the old response cancelled with no replacement turn")
		}
		t.Log("60ms provisional pulse cancelled the Worker and advanced generation; subsequent 320ms minimum rejection did not restore either")
	})
}

func TestCancellationReproducesRun6GreetingAndSequences2Through8(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, w, tr := cancellationPipeline(t, ConversationConfig{Greet: true}) // exact main.go configuration
		start := time.Now()
		if !p.Speaking() || tr.count() != 1 {
			t.Fatal("greeting did not begin")
		}
		time.Sleep(352 * time.Millisecond)
		cancellationFrames(p, 3, 40) // third frame at +412ms
		if time.Since(start) != 412*time.Millisecond || p.BargeIns() != 1 || p.Speaking() {
			t.Fatal("412ms greeting interruption not reproduced")
		}
		greetingWrites := tr.count()
		if greetingWrites != 21 {
			t.Fatalf("greeting packets=%d, want observed 21", greetingWrites)
		}
		cancellationFrames(p, 19, 120)
		cancellationFrames(p, 35, 3)
		if w.attempt(t, 2).req.DurationMs != 1140 {
			t.Fatal("first caller segment duration differs from Run #6")
		}
		// Known caller durations are retained. Sequence 7 has no retained ASR
		// duration or precise request age; its 760ms segment and 1000ms pending
		// request age are explicitly synthetic, not historical facts.
		nextDurations := []int{760, 2080, 1200, 1520, 760, 760, 1760}
		requestAges := []time.Duration{6294, 715, 278, 2759, 1213, 1000, 5319}
		for i, duration := range nextDurations {
			sequence := i + 2
			a := w.attempt(t, sequence)
			if a.ctx.Err() != nil {
				t.Fatalf("sequence %d was not live before stimulus", sequence)
			}
			age := requestAges[i] * time.Millisecond
			time.Sleep(age - 60*time.Millisecond - time.Since(a.started))
			cancellationFrames(p, 3, 40)
			<-a.done
			if !errors.Is(a.err, context.Canceled) || time.Since(a.started) != age || p.Turns() != sequence {
				t.Fatalf("sequence %d cancellation must occur before replacement dispatch, not timeout", sequence)
			}
			if tr.count() != greetingWrites {
				t.Fatal("cancelled substantive response unexpectedly played")
			}
			cancellationFrames(p, (duration-700)/20-3, 120)
			cancellationFrames(p, 35, 3)
			if w.attempt(t, sequence+1).req.DurationMs != duration {
				t.Fatalf("sequence %d segment mismatch", sequence+1)
			}
		}
		if p.Turns() != 9 || p.BargeIns() != 1 {
			t.Fatal("seven pending-request cancellations should not add seven playback barge-in logs")
		}
		// Control: the same unmodified pipeline responds once there is no new
		// provisional speech. This is not a replay of the historical final turn.
		close(w.attempt(t, 9).release)
		p.wg.Wait()
		if tr.count() != greetingWrites+4 || p.busyNow() {
			t.Fatal("stable current turn could not complete")
		}
		t.Log("greeting interrupted +412ms; seven pre-deadline context.Canceled results for seq2–8; seq9 completes when left current")
	})
}

func TestCancellationGenuineInterruptionPreservesNextCallerTurn(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, w, tr, a := cancellationPending(t, ConversationConfig{VAD: DefaultVADConfig()})
		close(a.release)
		synctest.Wait()
		if !p.Speaking() {
			t.Fatal("substantive playback not active")
		}
		cancellationFrames(p, 3, 120)
		count := tr.count()
		if p.BargeIns() != 1 || p.Speaking() {
			t.Fatal("real interruption did not stop playback")
		}
		cancellationFrames(p, 22, 120) // sustained 500ms caller turn, above minimum
		cancellationFrames(p, 35, 3)
		if w.attempt(t, 2).req.DurationMs != 1200 || tr.count() != count {
			t.Fatal("caller turn lost or stale speech continued")
		}
		close(w.attempt(t, 2).release)
		p.wg.Wait()
		if tr.count() != count+4 {
			t.Fatal("caller resumption did not receive a current response")
		}
	})
}

func TestCancellationCharacterizesTeardownAndProcessingDeadline(t *testing.T) {
	for _, cause := range []string{"teardown", "deadline"} {
		t.Run(cause, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				p, _, tr, a := cancellationPending(t, ConversationConfig{})
				if cause == "teardown" {
					p.Close("caller_terminated")
				} else {
					time.Sleep(20 * time.Second)
					synctest.Wait()
				}
				<-a.done
				want := context.Canceled
				if cause == "deadline" {
					want = context.DeadlineExceeded
				}
				if !errors.Is(a.err, want) || tr.count() != 0 {
					t.Fatalf("cause %s: %v", cause, a.err)
				}
			})
		})
	}
}

// Deliberately RED on the unchanged gateway. Do not skip, invert or weaken:
// the requested Case B must eventually keep an in-flight response alive.
func TestCancellationSafetyShortPulseMustPreservePendingResponse(t *testing.T) {
	for _, explicitMinimum := range []bool{false, true} {
		name := "production_zero_config"
		if explicitMinimum {
			name = "explicit_320ms_minimum"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				cfg := ConversationConfig{}
				if explicitMinimum {
					cfg.VAD = DefaultVADConfig()
				}
				p, _, _, a := cancellationPending(t, cfg)
				generation := p.generation
				cancellationFrames(p, 3, 40)
				if a.ctx.Err() != nil {
					t.Errorf("CASE B FAIL: pending Worker cancelled by 60ms provisional activity before a valid utterance: %v", a.ctx.Err())
				}
				if p.generation != generation {
					t.Errorf("CASE B FAIL: provisional activity superseded generation %d -> %d", generation, p.generation)
				}
			})
		})
	}
}
