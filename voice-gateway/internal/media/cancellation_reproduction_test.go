package media

// Regression coverage for the b5c9f4e cancellation defect. Synthetic packet
// sizes exercise the existing heuristic; they are not Founder audio recordings.
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
	if v.MinUtteranceMs != 320 || DefaultVADConfig().MinUtteranceMs != 320 {
		t.Fatal("zero configuration must retain the 320ms speech evidence minimum")
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
		{"third_frame_only", []int{40, 40, 40}, false},
		{"below_qualification", makeCancellationSizes(15, 40), false},
		{"qualified_speech", makeCancellationSizes(16, 40), true},
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
					if !errors.Is(a.err, context.Canceled) || !p.seg.Qualified() || p.Turns() != 1 || p.generation != before+1 {
						t.Fatal("qualified cancellation must precede finalization/new sequence")
					}
				}
			})
		})
	}
}

func makeCancellationSizes(count, size int) []int {
	sizes := make([]int, count)
	for i := range sizes {
		sizes[i] = size
	}
	return sizes
}

func TestCancellationDiscardedPulsePreservesReadyResponse(t *testing.T) {
	for _, cfg := range []ConversationConfig{{}, {VAD: DefaultVADConfig()}} {
		synctest.Test(t, func(t *testing.T) {
			p, _, tr, a := cancellationPending(t, cfg)
			before := p.generation
			cancellationFrames(p, 3, 40)
			if a.ctx.Err() != nil || p.generation != before {
				t.Fatal("provisional pulse destroyed ownership")
			}
			close(a.release) // valid response arrives while qualification is unresolved
			synctest.Wait()
			if !p.busyNow() || tr.count() != 0 {
				t.Fatal("ready response was discarded or spoke over provisional activity")
			}
			cancellationFrames(p, 35, 3)
			p.wg.Wait()
			if p.seg.Speaking() || p.Turns() != 1 || p.generation != before || tr.count() != 4 {
				t.Fatal("rejected pulse lost the pending response or allocated another turn")
			}
		})
	}
}

func TestCancellationRun6TransientPatternNoLongerCancelsSequences(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, w, tr := cancellationPipeline(t, ConversationConfig{Greet: true})
		start := time.Now()
		if !p.Speaking() || tr.count() != 1 {
			t.Fatal("greeting did not begin")
		}
		time.Sleep(352 * time.Millisecond)
		cancellationFrames(p, 3, 40)
		if time.Since(start) != 412*time.Millisecond || p.BargeIns() != 0 || p.generation != 0 {
			t.Fatal("provisional +412ms onset must not supersede greeting")
		}
		greetingWrites := tr.count()
		if greetingWrites != 21 {
			t.Fatalf("greeting packets=%d, want 21 before provisional pause", greetingWrites)
		}
		cancellationFrames(p, 13, 120) // 320ms speech evidence; one real interruption
		if p.BargeIns() != 1 || p.Speaking() || tr.count() != greetingWrites {
			t.Fatal("qualified interruption lost prompt playback pause")
		}
		cancellationFrames(p, 6, 120)
		cancellationFrames(p, 35, 3)
		a := w.attempt(t, 2)
		if a.req.DurationMs != 1140 {
			t.Fatal("first retained caller segment changed")
		}
		generation := p.generation
		time.Sleep(6234 * time.Millisecond)
		// Seven synthetic short activations model the destructive trigger from the
		// prior seq2–8 reproduction. These are not seven reconstructed recordings.
		for i := 0; i < 7; i++ {
			cancellationFrames(p, 3, 40)
			cancellationFrames(p, 35, 3)
			if a.ctx.Err() != nil || p.generation != generation || p.Turns() != 2 || tr.count() != greetingWrites {
				t.Fatalf("transient activation %d cancelled, superseded, dispatched or leaked audio", i+1)
			}
		}
		close(a.release)
		p.wg.Wait()
		if tr.count() != greetingWrites+4 || p.busyNow() {
			t.Fatal("substantive response did not survive repeated transient activity")
		}
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
		generation := p.generation
		cancellationFrames(p, 3, 120)
		count := tr.count()
		if p.BargeIns() != 0 || p.generation != generation {
			t.Fatal("provisional activity superseded playback")
		}
		cancellationFrames(p, 13, 120)
		if p.BargeIns() != 1 || p.Speaking() || p.generation != generation+1 || tr.count() != count {
			t.Fatal("qualified interruption did not stop playback once")
		}
		cancellationFrames(p, 9, 120) // sustained 500ms caller turn, above minimum
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

func TestCancellationQualificationCancelsAndDispatchesExactlyOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, w, tr, a := cancellationPending(t, ConversationConfig{})
		generation := p.generation
		cancellations := 0
		p.mu.Lock()
		cancel := p.cancelTurn
		p.cancelTurn = func() { cancellations++; cancel() }
		p.mu.Unlock()
		cancellationFrames(p, 15, 40)
		if a.ctx.Err() != nil || cancellations != 0 || p.generation != generation {
			t.Fatal("cancelled before 320ms qualification")
		}
		cancellationFrames(p, 1, 40)
		<-a.done
		if !errors.Is(a.err, context.Canceled) || cancellations != 1 || p.generation != generation+1 || p.Turns() != 1 {
			t.Fatal("qualification did not exclusively supersede the active request")
		}
		cancellationFrames(p, 9, 120)
		cancellationFrames(p, 35, 3)
		next := w.attempt(t, 2)
		if cancellations != 1 || p.generation != generation+1 || p.Turns() != 2 || next.req.DurationMs != 1200 {
			t.Fatal("duplicate cancellation, generation increment or dispatch")
		}
		close(next.release)
		p.wg.Wait()
		if tr.count() != 4 {
			t.Fatal("qualified caller turn did not receive its response")
		}
	})
}

func TestCancellationCharacterizesTeardownAndProcessingDeadline(t *testing.T) {
	for _, cause := range []string{"teardown", "deadline"} {
		t.Run(cause, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				p, _, tr, a := cancellationPending(t, ConversationConfig{})
				if cause == "teardown" {
					cancellationFrames(p, 3, 40)
					if a.ctx.Err() != nil {
						t.Fatal("provisional speech cancelled before teardown")
					}
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

// Previously RED on b5c9f4e: retain both safety assertions unchanged.
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

func TestCancellationProvisionalPauseResumesPlaybackWithoutPacketBurst(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, _, tr, a := cancellationPending(t, ConversationConfig{})
		close(a.release)
		synctest.Wait()
		generation := p.generation
		cancellationFrames(p, 3, 40)
		paused := tr.count()
		cancellationFrames(p, 35, 3)
		// The retained final frame may already have been sent when activity began;
		// otherwise resumption emits at most one frame, preserving 20ms cadence.
		resumed := tr.count()
		if resumed > paused+1 || p.generation != generation || p.BargeIns() != 0 {
			t.Fatal("short pulse cancelled ownership or resumed with a packet burst")
		}
		time.Sleep(19 * time.Millisecond)
		synctest.Wait()
		if tr.count() != resumed {
			t.Fatal("resumed playback exceeded existing packet cadence")
		}
		p.wg.Wait()
		if tr.count() != 4 {
			t.Fatal("provisional pause discarded audio")
		}
	})
}

func TestCancellationQualifiedOnMaximumBoundaryOwnsTurnOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, w, tr := cancellationPipeline(t, ConversationConfig{VAD: VADConfig{MaxUtteranceMs: 320}})
		cancellationFrames(p, 16, 120) // qualification and force-finalization coincide
		a := w.attempt(t, 1)
		if p.generation != 1 || a.req.DurationMs != 320 {
			t.Fatal("maximum-boundary qualification lost or duplicated ownership")
		}
		close(a.release)
		synctest.Wait()
		if tr.count() != 0 {
			t.Fatal("forced boundary spoke over continuing caller")
		}
		cancellationFrames(p, 35, 3)
		p.wg.Wait()
		if tr.count() != 4 || p.Turns() != 1 || p.generation != 1 {
			t.Fatal("forced boundary lost response or duplicated dispatch")
		}
	})
}

func TestCancellationProvisionalWaitRetainsOriginalDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p, _, tr, a := cancellationPending(t, ConversationConfig{})
		start := a.started
		cancellationFrames(p, 3, 40)
		close(a.release)
		p.wg.Wait() // no silence or qualification arrives; existing 20s limit owns wait
		if time.Since(start) != 20*time.Second || tr.count() != 0 || p.busyNow() {
			t.Fatal("provisional wait leaked or changed processing deadline")
		}
	})
}
