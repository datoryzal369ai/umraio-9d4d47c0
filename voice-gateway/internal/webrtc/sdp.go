package webrtc

import (
	"errors"
	"strings"
)

// MaxSDPBytes bounds untrusted SDP input.
const MaxSDPBytes = 16 * 1024

var (
	ErrSDPTooLarge   = errors.New("webrtc: sdp exceeds size limit")
	ErrSDPEmpty      = errors.New("webrtc: empty sdp")
	ErrSDPStructure  = errors.New("webrtc: sdp missing required lines")
	ErrSDPNoAudio    = errors.New("webrtc: sdp has no audio media section")
	ErrSDPNoOpus     = errors.New("webrtc: sdp does not offer opus")
	ErrSDPNoDTLS     = errors.New("webrtc: sdp has no dtls fingerprint")
	ErrSDPNoICE      = errors.New("webrtc: sdp has no ice credentials")
	ErrSDPNotSecured = errors.New("webrtc: sdp does not request a secure (SRTP) profile")
)

// ValidateOffer performs cheap structural validation before any of the offer
// reaches the WebRTC stack. It never logs or returns SDP content.
func ValidateOffer(sdp string) error {
	if len(sdp) == 0 {
		return ErrSDPEmpty
	}
	if len(sdp) > MaxSDPBytes {
		return ErrSDPTooLarge
	}
	lower := strings.ToLower(sdp)
	if !strings.HasPrefix(sdp, "v=0") || !strings.Contains(lower, "o=") || !strings.Contains(lower, "s=") {
		return ErrSDPStructure
	}
	if !strings.Contains(lower, "m=audio") {
		return ErrSDPNoAudio
	}
	if !strings.Contains(lower, "opus/48000") {
		return ErrSDPNoOpus
	}
	if !strings.Contains(lower, "a=fingerprint:") {
		return ErrSDPNoDTLS
	}
	if !strings.Contains(lower, "a=ice-ufrag:") || !strings.Contains(lower, "a=ice-pwd:") {
		return ErrSDPNoICE
	}
	if !strings.Contains(lower, "savpf") && !strings.Contains(lower, "savp") {
		return ErrSDPNotSecured
	}
	return nil
}

// NormalizeOfferTerminator guarantees the final SDP line is newline-terminated.
// Pion's SDP lexer returns io.EOF ("failed to unmarshal SDP: EOF") when the
// last line has no terminator. It never trims, reorders or rewrites content.
func NormalizeOfferTerminator(sdp string) string {
	if sdp == "" || strings.HasSuffix(sdp, "\n") {
		return sdp
	}
	return sdp + "\r\n"
}

// AnswerSummary is a structural, non-sensitive description of a local answer.
// It deliberately carries no IPs, ports, candidate strings, ICE credentials,
// fingerprints or raw SDP — only counts and booleans safe to log.
type AnswerSummary struct {
	Present        bool
	Length         int
	CandidateCount int
	HasHost        bool
	HasSrflx       bool
	HasRelay       bool
	HasAudio       bool
	HasOpus        bool
}

// SummarizeAnswer derives loggable structure from an SDP answer.
func SummarizeAnswer(sdp string) AnswerSummary {
	s := AnswerSummary{Present: strings.TrimSpace(sdp) != "", Length: len(sdp)}
	lower := strings.ToLower(sdp)
	s.HasAudio = strings.Contains(lower, "m=audio")
	s.HasOpus = strings.Contains(lower, "opus/48000")
	for _, line := range strings.Split(lower, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		s.CandidateCount++
		switch {
		case strings.Contains(line, " typ host"):
			s.HasHost = true
		case strings.Contains(line, " typ srflx"):
			s.HasSrflx = true
		case strings.Contains(line, " typ relay"):
			s.HasRelay = true
		}
	}
	return s
}

// LogAttrs renders the summary as flat structured log fields.
func (s AnswerSummary) LogAttrs() []any {
	return []any{
		"answer_sdp_present", s.Present,
		"answer_length", s.Length,
		"candidate_count", s.CandidateCount,
		"has_host_candidate", s.HasHost,
		"has_srflx_candidate", s.HasSrflx,
		"has_relay_candidate", s.HasRelay,
		"has_audio", s.HasAudio,
		"has_opus", s.HasOpus,
	}
}
