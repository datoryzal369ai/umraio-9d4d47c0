package media

import "testing"

func frames(seg *Segmenter, count, size int) (VADEvent, [][]byte) {
	var last VADEvent
	var out [][]byte
	for i := 0; i < count; i++ {
		ev, utt := seg.Push(OpusFrame{Data: make([]byte, size)})
		if ev != VADNone {
			last, out = ev, utt
		}
	}
	return last, out
}

func TestVADDetectsSpeechStartAndEnd(t *testing.T) {
	seg := NewSegmenter(VADConfig{FrameMs: 20, SpeechMinBytes: 40, StartFrames: 3, EndSilenceMs: 100, MinUtteranceMs: 60, MaxUtteranceMs: 2000})
	if ev, _ := frames(seg, 3, 120); ev != VADSpeechStart {
		t.Fatalf("expected speech start, got %v", ev)
	}
	frames(seg, 10, 120)
	ev, utterance := frames(seg, 5, 3)
	if ev != VADUtteranceEnd {
		t.Fatalf("expected utterance end, got %v", ev)
	}
	if len(utterance) == 0 {
		t.Fatal("utterance must carry the captured frames")
	}
}

func TestVADIgnoresIsolatedNoise(t *testing.T) {
	seg := NewSegmenter(DefaultVADConfig())
	for i := 0; i < 20; i++ {
		if ev, _ := seg.Push(OpusFrame{Data: make([]byte, 200)}); ev == VADSpeechStart && i < 2 {
			t.Fatal("speech declared too early")
		}
		seg.Push(OpusFrame{Data: make([]byte, 2)})
	}
	if seg.Speaking() {
		t.Fatal("alternating noise must not hold an utterance open")
	}
}

func TestVADDiscardsTooShortUtterance(t *testing.T) {
	seg := NewSegmenter(VADConfig{FrameMs: 20, SpeechMinBytes: 40, StartFrames: 2, EndSilenceMs: 40, MinUtteranceMs: 500, MaxUtteranceMs: 2000})
	frames(seg, 2, 120)
	ev, utt := frames(seg, 2, 3)
	if ev != VADDiscarded || utt != nil {
		t.Fatalf("expected discard, got %v", ev)
	}
}

func TestVADBoundsMaximumUtterance(t *testing.T) {
	seg := NewSegmenter(VADConfig{FrameMs: 20, SpeechMinBytes: 40, StartFrames: 2, EndSilenceMs: 10000, MinUtteranceMs: 20, MaxUtteranceMs: 200})
	ev, utt := frames(seg, 40, 120)
	if ev != VADUtteranceEnd {
		t.Fatalf("expected forced end, got %v", ev)
	}
	if len(utt)*20 > 260 {
		t.Fatalf("utterance exceeded ceiling: %d frames", len(utt))
	}
	if seg.Speaking() {
		t.Fatal("segmenter must reset after forced end")
	}
}

func TestVADConfigDefaultsAreApplied(t *testing.T) {
	seg := NewSegmenter(VADConfig{})
	if seg.Config().FrameMs != 20 || seg.Config().MaxUtteranceMs == 0 {
		t.Fatalf("defaults not applied: %+v", seg.Config())
	}
}

func TestVADQualificationRequiresSpeechEvidence(t *testing.T) {
	seg := NewSegmenter(VADConfig{})
	if seg.Config().MinUtteranceMs != 320 {
		t.Fatal("zero config bypassed qualification")
	}
	ev, _ := frames(seg, 3, 40)
	if ev != VADSpeechStart || seg.Qualified() {
		t.Fatal("60ms must remain provisional")
	}
	frames(seg, 20, 3) // 400ms buffering is not additional speech evidence
	if seg.Qualified() {
		t.Fatal("silence qualified an interruption")
	}
	frames(seg, 12, 40)
	if seg.Qualified() {
		t.Fatal("300ms speech qualified too early")
	}
	frames(seg, 1, 40)
	if !seg.Qualified() {
		t.Fatal("320ms speech did not qualify promptly")
	}
	ev, audio := frames(seg, 35, 3)
	if ev != VADUtteranceEnd || len(audio) == 0 || seg.Qualified() {
		t.Fatal("qualified utterance lost or qualification did not reset")
	}
}

func TestVADBufferedSilenceCannotTurnShortPulsesIntoValidUtterance(t *testing.T) {
	seg := NewSegmenter(VADConfig{})
	frames(seg, 3, 40)
	frames(seg, 25, 3)
	frames(seg, 3, 40) // 120ms total speech despite 620ms elapsed buffering
	ev, audio := frames(seg, 35, 3)
	if ev != VADDiscarded || audio != nil || seg.Qualified() {
		t.Fatal("sparse short activity qualified by elapsed time instead of speech evidence")
	}
}
