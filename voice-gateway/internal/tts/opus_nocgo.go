//go:build !cgo

package tts

import "errors"

// FrameMs is the packet duration the RTP sender paces with.
const FrameMs = 20

var ErrEncoder = errors.New("tts: opus encoder unavailable (built without cgo)")

// EncoderAvailable reports whether this build can encode Opus. A CGO-less
// build fails closed: the pipeline reports it and the caller hears silence,
// which is always preferable to a substituted voice.
func EncoderAvailable() bool { return false }

func EncodeOpus(_ []byte) ([][]byte, error) { return nil, ErrEncoder }
