//go:build cgo

package tts

// Native Opus encoding (libopus). This is the capability the serverless Worker
// does not have and the reason synthesis moved into the media plane.
//
// MiniMax delivers s16le / 24 kHz / mono PCM. libopus accepts 24 kHz natively,
// so there is NO resampling and no extra lossy stage: 20 ms frames in, one
// Opus packet out, ready for RTP at the negotiated 48 kHz clock.

import (
	"errors"

	opus "gopkg.in/hraban/opus.v2"
)

// FrameMs is the packet duration the RTP sender paces with.
const FrameMs = 20

// frameSamples is 20 ms at the MiniMax PCM rate.
const frameSamples = SampleRateHz / 1000 * FrameMs

// TargetBitrate keeps narrowband speech clear without bloating RTP.
const TargetBitrate = 24000

var ErrEncoder = errors.New("tts: opus encoder unavailable")

// EncoderAvailable reports whether this build can encode Opus.
func EncoderAvailable() bool { return true }

// EncodeOpus converts PCM into 20 ms Opus packets. Trailing audio shorter than
// one frame is zero-padded so no speech is truncated.
func EncodeOpus(pcm []byte) ([][]byte, error) {
	if len(pcm) < 2 {
		return nil, ErrEmptyAudio
	}
	enc, err := opus.NewEncoder(SampleRateHz, Channels, opus.AppVoIP)
	if err != nil {
		return nil, ErrEncoder
	}
	if err := enc.SetBitrate(TargetBitrate); err != nil {
		return nil, ErrEncoder
	}

	samples := make([]int16, 0, len(pcm)/2)
	for i := 0; i+1 < len(pcm); i += 2 {
		samples = append(samples, int16(pcm[i])|int16(pcm[i+1])<<8)
	}

	packets := make([][]byte, 0, len(samples)/frameSamples+1)
	buf := make([]byte, 4000)
	for offset := 0; offset < len(samples); offset += frameSamples {
		frame := make([]int16, frameSamples)
		copy(frame, samples[offset:min(offset+frameSamples, len(samples))])
		n, encErr := enc.Encode(frame, buf)
		if encErr != nil || n <= 0 {
			return nil, ErrEncoder
		}
		packet := make([]byte, n)
		copy(packet, buf[:n])
		packets = append(packets, packet)
	}
	if len(packets) == 0 {
		return nil, ErrEmptyAudio
	}
	return packets, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
