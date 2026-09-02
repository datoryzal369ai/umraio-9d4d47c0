package webrtc

// Structural, non-sensitive diagnostics for the audio negotiation path.
// Nothing here ever returns or logs raw SDP, ICE credentials, candidates,
// fingerprints or addresses: only enums, booleans and small integers.

import (
	"strconv"
	"strings"

	pion "github.com/pion/webrtc/v4"
)

// Direction enums are fixed strings; anything unrecognised becomes "unknown".
const (
	DirSendRecv = "sendrecv"
	DirSendOnly = "sendonly"
	DirRecvOnly = "recvonly"
	DirInactive = "inactive"
	DirUnknown  = "unknown"
)

// AudioSDPSummary describes the audio media section of an offer or answer.
type AudioSDPSummary struct {
	AudioPresent    bool
	Rejected        bool // m=audio port 0
	Direction       string
	OpusPresent     bool
	OpusPayloadType int
	OpusClockRate   int
	OpusChannels    int
	MidPresent      bool
	BundlePresent   bool
	MediaSections   int
}

// PermitsRemoteSend reads the section as a REMOTE offer: true when the remote
// side declares it will send audio to us.
func (s AudioSDPSummary) PermitsRemoteSend() bool {
	return s.AudioPresent && !s.Rejected &&
		(s.Direction == DirSendRecv || s.Direction == DirSendOnly)
}

// PermitsLocalReceive reads the section as our LOCAL answer: true when the
// advertised direction allows caller audio to reach us.
func (s AudioSDPSummary) PermitsLocalReceive() bool {
	return s.AudioPresent && !s.Rejected &&
		(s.Direction == DirSendRecv || s.Direction == DirRecvOnly)
}


func normalizeDirection(v string) string {
	switch v {
	case DirSendRecv, DirSendOnly, DirRecvOnly, DirInactive:
		return v
	default:
		return DirUnknown
	}
}

// SummarizeAudioSDP extracts the structural audio facts from any SDP.
func SummarizeAudioSDP(sdp string) AudioSDPSummary {
	s := AudioSDPSummary{Direction: DirUnknown}
	if strings.TrimSpace(sdp) == "" {
		return s
	}
	inAudio := false
	for _, raw := range strings.Split(sdp, "\n") {
		line := strings.TrimSpace(raw)
		lower := strings.ToLower(line)
		switch {
		case strings.HasPrefix(lower, "a=group:bundle"):
			s.BundlePresent = true
		case strings.HasPrefix(lower, "m="):
			s.MediaSections++
			inAudio = strings.HasPrefix(lower, "m=audio")
			if inAudio {
				s.AudioPresent = true
				// m=audio <port> <proto> <fmt...>
				if f := strings.Fields(line); len(f) >= 2 && f[1] == "0" {
					s.Rejected = true
				}
				// SDP default when no direction attribute is present.
				if s.Direction == DirUnknown {
					s.Direction = DirSendRecv
				}
			}
		case inAudio && strings.HasPrefix(lower, "a=mid:"):
			s.MidPresent = true
		case inAudio && (lower == "a=sendrecv" || lower == "a=sendonly" ||
			lower == "a=recvonly" || lower == "a=inactive"):
			s.Direction = normalizeDirection(strings.TrimPrefix(lower, "a="))
		case inAudio && strings.HasPrefix(lower, "a=rtpmap:") && strings.Contains(lower, "opus/"):
			s.OpusPresent = true
			pt, clock, ch := parseOpusRtpmap(lower)
			s.OpusPayloadType, s.OpusClockRate, s.OpusChannels = pt, clock, ch
		}
	}
	return s
}

// parseOpusRtpmap reads "a=rtpmap:<pt> opus/<clock>[/<channels>]".
func parseOpusRtpmap(lower string) (pt, clock, channels int) {
	body := strings.TrimPrefix(lower, "a=rtpmap:")
	fields := strings.Fields(body)
	if len(fields) < 2 {
		return 0, 0, 0
	}
	pt, _ = strconv.Atoi(fields[0])
	parts := strings.Split(fields[1], "/")
	if len(parts) >= 2 {
		clock, _ = strconv.Atoi(parts[1])
	}
	channels = 1
	if len(parts) >= 3 {
		if c, err := strconv.Atoi(parts[2]); err == nil {
			channels = c
		}
	}
	return pt, clock, channels
}

// LogAttrs renders an offer/answer summary as flat log fields.
func (s AudioSDPSummary) LogAttrs(prefix string) []any {
	return []any{
		prefix + "_audio_present", s.AudioPresent,
		prefix + "_audio_rejected", s.Rejected,
		prefix + "_audio_direction", s.Direction,
		prefix + "_opus_present", s.OpusPresent,
		prefix + "_opus_payload_type", s.OpusPayloadType,
		prefix + "_opus_clock_rate", s.OpusClockRate,
		prefix + "_opus_channels", s.OpusChannels,
		prefix + "_mid_present", s.MidPresent,
		prefix + "_bundle_present", s.BundlePresent,
		prefix + "_media_sections", s.MediaSections,
	}
}

// TransceiverAudit is the live view of our own peer connection's audio path.
type TransceiverAudit struct {
	AudioTransceivers  int
	Direction          string
	ReceiverNegotiated bool
	SenderNegotiated   bool
	MidPresent         bool
}

// CanReceiveAudio is the invariant that must hold for OnTrack to ever fire.
func (a TransceiverAudit) CanReceiveAudio() bool {
	return a.ReceiverNegotiated &&
		(a.Direction == DirSendRecv || a.Direction == DirRecvOnly)
}

// AuditTransceivers inspects the peer connection without touching media.
func AuditTransceivers(pc *pion.PeerConnection) TransceiverAudit {
	a := TransceiverAudit{Direction: DirUnknown}
	if pc == nil {
		return a
	}
	for _, tr := range pc.GetTransceivers() {
		if tr == nil || tr.Kind() != pion.RTPCodecTypeAudio {
			continue
		}
		a.AudioTransceivers++
		if a.AudioTransceivers > 1 {
			continue // first audio transceiver is the negotiated one
		}
		a.Direction = normalizeDirection(tr.Direction().String())
		if tr.Mid() != "" {
			a.MidPresent = true
		}
		if r := tr.Receiver(); r != nil {
			a.ReceiverNegotiated = true
		}
		if snd := tr.Sender(); snd != nil && snd.Track() != nil {
			a.SenderNegotiated = true
		}
	}
	return a
}

// LogAttrs renders the transceiver audit as flat log fields.
func (a TransceiverAudit) LogAttrs() []any {
	return []any{
		"audio_transceiver_count", a.AudioTransceivers,
		"audio_transceiver_direction", a.Direction,
		"audio_receiver_negotiated", a.ReceiverNegotiated,
		"audio_sender_negotiated", a.SenderNegotiated,
		"transceiver_mid_present", a.MidPresent,
		"can_receive_audio", a.CanReceiveAudio(),
	}
}
