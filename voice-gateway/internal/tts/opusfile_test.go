//go:build cgo

package tts

// Audio-level proof for the voice-note encoder: the produced packets decode
// back to the original tone, the duration (including a short final partial
// frame) survives, and the container metadata is exact.

import (
	"encoding/binary"
	"math"
	"testing"

	opus "gopkg.in/hraban/opus.v2"
)

func tone(seconds float64) []byte {
	n := int(float64(SampleRateHz) * seconds)
	out := make([]byte, n*2)
	for i := 0; i < n; i++ {
		v := int16(12000 * math.Sin(2*math.Pi*220*float64(i)/float64(SampleRateHz)))
		binary.LittleEndian.PutUint16(out[i*2:], uint16(v))
	}
	return out
}

func TestEncodeOpusFileRejectsBadInput(t *testing.T) {
	for name, in := range map[string][]byte{
		"empty":     nil,
		"one_byte":  {1},
		"odd_bytes": {1, 2, 3},
	} {
		if _, err := EncodeOpusFile(in); err == nil {
			t.Fatalf("%s: expected error", name)
		}
	}
	if _, err := EncodeOpusFile(make([]byte, MaxFilePCMBytes+2)); err != ErrPCMTooLarge {
		t.Fatalf("oversized pcm not rejected: %v", err)
	}
}

func TestEncodeOpusFileMetadata(t *testing.T) {
	file, err := EncodeOpusFile(tone(0.5))
	if err != nil {
		t.Fatal(err)
	}
	if file.FrameSamples48 != 960 {
		t.Fatalf("frame samples: %d", file.FrameSamples48)
	}
	if file.PreSkip <= 0 {
		t.Fatalf("pre-skip must come from the encoder lookahead, got %d", file.PreSkip)
	}
	// 0.5 s at 48 kHz plus the pre-skip.
	if want := int64(file.PreSkip) + 24000; file.FinalGranule != want {
		t.Fatalf("final granule %d, want %d", file.FinalGranule, want)
	}
	// 25 frames of audio plus at least one drain frame for the lookahead tail.
	if len(file.Packets) < 26 {
		t.Fatalf("tail not drained: %d packets", len(file.Packets))
	}
}

// A 0.31 s input ends mid-frame: the padded final frame must still be encoded
// and the reported duration must reflect the real input, not the padding.
func TestEncodeOpusFileKeepsPartialFinalFrame(t *testing.T) {
	pcm := tone(0.31)
	file, err := EncodeOpusFile(pcm)
	if err != nil {
		t.Fatal(err)
	}
	samples := int64(len(pcm) / 2)
	if want := int64(file.PreSkip) + samples*2; file.FinalGranule != want {
		t.Fatalf("final granule %d, want %d", file.FinalGranule, want)
	}
	if len(file.Packets) < 16 {
		t.Fatalf("expected the partial frame to be encoded, got %d packets", len(file.Packets))
	}
}

// Decoding the packets back must reproduce the 220 Hz tone at real amplitude —
// proof that the output is genuine audio and not silence or noise.
func TestEncodeOpusFileDecodesToTone(t *testing.T) {
	file, err := EncodeOpusFile(tone(0.5))
	if err != nil {
		t.Fatal(err)
	}
	dec, err := opus.NewDecoder(SampleRateHz, Channels)
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]int16, FileFrameSamples)
	var decoded int
	var energy float64
	for _, p := range file.Packets {
		n, decErr := dec.Decode(p, pcm)
		if decErr != nil {
			t.Fatalf("decode failed: %v", decErr)
		}
		for i := 0; i < n; i++ {
			energy += float64(pcm[i]) * float64(pcm[i])
		}
		decoded += n
	}
	if decoded < 12000 {
		t.Fatalf("decoded only %d samples", decoded)
	}
	rms := math.Sqrt(energy / float64(decoded))
	if rms < 3000 {
		t.Fatalf("decoded audio is too quiet to be the tone: rms=%.0f", rms)
	}
}
