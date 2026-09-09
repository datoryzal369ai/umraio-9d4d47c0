//go:build cgo

package tts

// FILE-QUALITY OPUS ENCODER (native libopus).
//
// This path exists ONLY for the WhatsApp voice note: MiniMax PCM in, a
// complete OGG/Opus file out. It is deliberately separate from EncodeOpus,
// which paces low-latency RTP for live calls and must not change.
//
// Profile: OPUS_APPLICATION_AUDIO, 48 kbps, complexity 10, fullband — the same
// settings the (unusable-in-Worker) WASM encoder used, so the voice identity is
// byte-for-byte the same intent: MiniMax s16le / 24 kHz / mono, no resampling.

/*
#cgo pkg-config: opus
#include <opus.h>
#include <stdlib.h>

static int umraio_set_bitrate(OpusEncoder *st, opus_int32 v) { return opus_encoder_ctl(st, OPUS_SET_BITRATE(v)); }
static int umraio_set_complexity(OpusEncoder *st, opus_int32 v) { return opus_encoder_ctl(st, OPUS_SET_COMPLEXITY(v)); }
static int umraio_set_bandwidth(OpusEncoder *st, opus_int32 v) { return opus_encoder_ctl(st, OPUS_SET_MAX_BANDWIDTH(v)); }
static int umraio_get_lookahead(OpusEncoder *st, opus_int32 *v) { return opus_encoder_ctl(st, OPUS_GET_LOOKAHEAD(v)); }
*/
import "C"

import (
	"encoding/binary"
	"errors"
	"unsafe"
)

const (
	// FileBitrate / FileComplexity are the locked voice-note quality profile.
	FileBitrate    = 48000
	FileComplexity = 10
	// FileFrameSamples is 20 ms at the MiniMax PCM rate (24 kHz).
	FileFrameSamples = SampleRateHz / 1000 * FrameMs
	// GranuleRate — Ogg granule positions are always expressed at 48 kHz.
	GranuleRate = 48000
	// MaxFilePCMBytes bounds a single conversion (~120 s of 24 kHz mono s16le).
	MaxFilePCMBytes = 24000 * 2 * 120
)

// ErrPCMTooLarge is returned instead of allocating an unbounded encoder buffer.
var ErrPCMTooLarge = errors.New("tts: pcm too large")

// FileEncoderAvailable reports whether this build can produce voice-note files.
func FileEncoderAvailable() bool { return true }

// OpusFile is a complete encode result: 20 ms packets plus the container
// metadata needed to write a spec-correct Ogg stream.
type OpusFile struct {
	Packets []([]byte)
	// PreSkip is the encoder lookahead expressed at the 48 kHz Ogg clock.
	PreSkip int
	// FinalGranule is preSkip + the real input duration at 48 kHz, so a decoder
	// trims both the encoder delay and the zero padding of the last frame.
	FinalGranule int64
	// FrameSamples48 is samples per packet at 48 kHz (960 for 20 ms).
	FrameSamples48 int
}

// EncodeOpusFile converts s16le / 24 kHz / mono PCM into 20 ms Opus packets.
// The tail is preserved: the input is zero-padded to a frame boundary and the
// encoder is drained with enough extra silence to flush its lookahead.
func EncodeOpusFile(pcm []byte) (*OpusFile, error) {
	if len(pcm) < 2 {
		return nil, ErrEmptyAudio
	}
	if len(pcm)%2 != 0 {
		return nil, ErrEmptyAudio
	}
	if len(pcm) > MaxFilePCMBytes {
		return nil, ErrPCMTooLarge
	}

	var cerr C.int
	size := C.opus_encoder_get_size(C.int(Channels))
	st := (*C.OpusEncoder)(C.malloc(C.size_t(size)))
	if st == nil {
		return nil, ErrEncoder
	}
	defer C.free(unsafe.Pointer(st))
	if C.opus_encoder_init(st, C.opus_int32(SampleRateHz), C.int(Channels), C.OPUS_APPLICATION_AUDIO) != C.OPUS_OK {
		return nil, ErrEncoder
	}
	if C.umraio_set_bitrate(st, C.opus_int32(FileBitrate)) != C.OPUS_OK {
		return nil, ErrEncoder
	}
	// Quality controls are best effort: an older libopus must still encode.
	C.umraio_set_complexity(st, C.opus_int32(FileComplexity))
	C.umraio_set_bandwidth(st, C.OPUS_BANDWIDTH_FULLBAND)

	var lookahead C.opus_int32
	// The lookahead must be known: silently assuming 0 would write a wrong
	// pre-skip and clip the head of every voice note.
	if C.umraio_get_lookahead(st, &lookahead) != C.OPUS_OK || lookahead < 0 {
		return nil, ErrEncoder
	}
	preSkip := int(lookahead) * (GranuleRate / SampleRateHz)

	samples := make([]int16, len(pcm)/2)
	for i := range samples {
		samples[i] = int16(binary.LittleEndian.Uint16(pcm[i*2:]))
	}

	// One encode pass over input + lookahead, rounded up to a frame boundary:
	// enough padding to flush the encoder delay, and never an extra all-silent
	// packet beyond it.
	frames := (len(samples) + int(lookahead) + FileFrameSamples - 1) / FileFrameSamples

	packets := make([][]byte, 0, frames)
	frame := make([]int16, FileFrameSamples)
	buf := make([]byte, 4000)
	for f := 0; f < frames; f++ {
		for i := range frame {
			frame[i] = 0
		}
		start := f * FileFrameSamples
		if start < len(samples) {
			copy(frame, samples[start:min(start+FileFrameSamples, len(samples))])
		}
		n := C.opus_encode(
			st,
			(*C.opus_int16)(unsafe.Pointer(&frame[0])),
			C.int(FileFrameSamples),
			(*C.uchar)(unsafe.Pointer(&buf[0])),
			C.opus_int32(len(buf)),
		)
		if n <= 0 {
			cerr = n
			_ = cerr
			return nil, ErrEncoder
		}
		packet := make([]byte, int(n))
		copy(packet, buf[:int(n)])
		packets = append(packets, packet)
	}
	if len(packets) == 0 {
		return nil, ErrEmptyAudio
	}

	return &OpusFile{
		Packets:        packets,
		PreSkip:        preSkip,
		FinalGranule:   int64(preSkip) + int64(len(samples))*int64(GranuleRate/SampleRateHz),
		FrameSamples48: FileFrameSamples * (GranuleRate / SampleRateHz),
	}, nil
}
