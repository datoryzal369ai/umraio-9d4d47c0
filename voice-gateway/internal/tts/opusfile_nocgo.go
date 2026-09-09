//go:build !cgo

package tts

import "errors"

const (
	FileBitrate      = 48000
	FileComplexity   = 10
	FileFrameSamples = SampleRateHz / 1000 * FrameMs
	GranuleRate      = 48000
	MaxFilePCMBytes  = 24000 * 2 * 120
)

var ErrPCMTooLarge = errors.New("tts: pcm too large")

// OpusFile mirrors the cgo build so callers compile either way.
type OpusFile struct {
	Packets        [][]byte
	PreSkip        int
	FinalGranule   int64
	FrameSamples48 int
}

// FileEncoderAvailable is false without cgo: the converter fails closed rather
// than returning a substituted or silent voice note.
func FileEncoderAvailable() bool { return false }

func EncodeOpusFile(_ []byte) (*OpusFile, error) { return nil, ErrEncoder }
