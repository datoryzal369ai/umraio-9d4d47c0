package media

// Voice activity detection for telephone-grade Opus RTP.
//
// The gateway runs with CGO disabled and holds no AI credentials, so it does
// NOT decode Opus. Segmentation uses the one signal that is genuinely present
// in the RTP payload itself: frame size. Opus DTX/comfort-noise frames during
// silence are a handful of bytes, speech frames are an order of magnitude
// larger. This is a real measurement of the received media — never a guess
// about what the caller said, and never a transcript.

import "time"

// VADConfig is fully configurable; the defaults are tuned for 20 ms Opus.
type VADConfig struct {
	// FrameMs is the packetisation interval of one inbound RTP payload.
	FrameMs int
	// SpeechMinBytes is the payload size at or above which a frame counts as
	// speech. Below it the frame is silence/comfort noise.
	SpeechMinBytes int
	// StartFrames is how many consecutive speech frames declare speech start.
	StartFrames int
	// EndSilenceMs of trailing silence closes an utterance.
	EndSilenceMs int
	// MinUtteranceMs discards sub-threshold blips (coughs, clicks).
	MinUtteranceMs int
	// MaxUtteranceMs force-closes a monologue so a turn always completes.
	MaxUtteranceMs int
}

func DefaultVADConfig() VADConfig {
	return VADConfig{
		FrameMs:        20,
		SpeechMinBytes: 40,
		StartFrames:    3,
		EndSilenceMs:   700,
		MinUtteranceMs: 320,
		MaxUtteranceMs: 15000,
	}
}

func (c VADConfig) normalized() VADConfig {
	d := DefaultVADConfig()
	if c.FrameMs <= 0 {
		c.FrameMs = d.FrameMs
	}
	if c.SpeechMinBytes <= 0 {
		c.SpeechMinBytes = d.SpeechMinBytes
	}
	if c.StartFrames <= 0 {
		c.StartFrames = d.StartFrames
	}
	if c.EndSilenceMs <= 0 {
		c.EndSilenceMs = d.EndSilenceMs
	}
	if c.MinUtteranceMs < 0 {
		c.MinUtteranceMs = d.MinUtteranceMs
	}
	if c.MaxUtteranceMs <= 0 {
		c.MaxUtteranceMs = d.MaxUtteranceMs
	}
	if c.MaxUtteranceMs < c.MinUtteranceMs {
		c.MaxUtteranceMs = c.MinUtteranceMs
	}
	return c
}

// VADEvent is what a single pushed frame changed.
type VADEvent int

const (
	// VADNone: nothing observable changed.
	VADNone VADEvent = iota
	// VADSpeechStart: the caller just started speaking (barge-in trigger).
	VADSpeechStart
	// VADUtteranceEnd: a complete, long-enough utterance is available.
	VADUtteranceEnd
	// VADDiscarded: an utterance closed but was too short to be real speech.
	VADDiscarded
)

// Segmenter turns a stream of Opus frames into bounded utterances.
// It is not safe for concurrent use; the pipeline owns one per call.
type Segmenter struct {
	cfg VADConfig

	inSpeech   bool
	speechRun  int
	silenceRun int
	buffered   [][]byte
	preroll    [][]byte
	durationMs int
}

func NewSegmenter(cfg VADConfig) *Segmenter {
	return &Segmenter{cfg: cfg.normalized()}
}

func (s *Segmenter) Config() VADConfig { return s.cfg }

// Speaking reports whether an utterance is currently open.
func (s *Segmenter) Speaking() bool { return s.inSpeech }

// Reset drops all buffered audio and returns to the listening state.
func (s *Segmenter) Reset() {
	s.inSpeech = false
	s.speechRun = 0
	s.silenceRun = 0
	s.buffered = nil
	s.preroll = nil
	s.durationMs = 0
}

// Push feeds one inbound Opus frame. When it returns VADUtteranceEnd the second
// value is the complete utterance in arrival order; otherwise it is nil.
func (s *Segmenter) Push(frame OpusFrame) (VADEvent, [][]byte) {
	isSpeech := len(frame.Data) >= s.cfg.SpeechMinBytes

	if !s.inSpeech {
		// Keep a short pre-roll so the utterance does not clip its own onset.
		s.preroll = append(s.preroll, frame.Data)
		if len(s.preroll) > s.cfg.StartFrames {
			s.preroll = s.preroll[len(s.preroll)-s.cfg.StartFrames:]
		}
		if !isSpeech {
			// Noise recovery: an isolated loud frame never opens an utterance.
			s.speechRun = 0
			return VADNone, nil
		}
		s.speechRun++
		if s.speechRun < s.cfg.StartFrames {
			return VADNone, nil
		}
		s.inSpeech = true
		s.buffered = append([][]byte{}, s.preroll...)
		s.durationMs = len(s.buffered) * s.cfg.FrameMs
		s.preroll = nil
		s.silenceRun = 0
		return VADSpeechStart, nil
	}

	s.buffered = append(s.buffered, frame.Data)
	s.durationMs += s.cfg.FrameMs
	if isSpeech {
		s.silenceRun = 0
	} else {
		s.silenceRun++
	}

	silenceMs := s.silenceRun * s.cfg.FrameMs
	if silenceMs >= s.cfg.EndSilenceMs || s.durationMs >= s.cfg.MaxUtteranceMs {
		return s.close(silenceMs)
	}
	return VADNone, nil
}

func (s *Segmenter) close(trailingSilenceMs int) (VADEvent, [][]byte) {
	voicedMs := s.durationMs - trailingSilenceMs
	utterance := s.buffered
	s.Reset()
	if voicedMs < s.cfg.MinUtteranceMs {
		return VADDiscarded, nil
	}
	return VADUtteranceEnd, utterance
}

// UtteranceDuration is the wall-clock length of a frame slice.
func (c VADConfig) UtteranceDuration(frames [][]byte) time.Duration {
	return time.Duration(len(frames)*c.normalized().FrameMs) * time.Millisecond
}
