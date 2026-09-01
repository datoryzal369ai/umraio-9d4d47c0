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
