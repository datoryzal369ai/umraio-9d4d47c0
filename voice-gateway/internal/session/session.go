// Package session owns the media-plane call lifecycle. The Worker remains
// authoritative for business call state; this state machine only describes what
// the media plane itself can observe.
package session

import (
	"errors"
	"sync"
	"time"
)

type State string

const (
	StateAuthenticating   State = "AUTHENTICATING"
	StateConnecting       State = "CONNECTING"
	StateMediaNegotiating State = "MEDIA_NEGOTIATING"
	StateMediaReady       State = "MEDIA_READY"
	StateActive           State = "ACTIVE"
	StateTerminating      State = "TERMINATING"
	StateTerminated       State = "TERMINATED"
	StateFailed           State = "FAILED"
)

// rank enforces forward-only progression. TERMINATED and FAILED are absorbing.
var rank = map[State]int{
	StateAuthenticating:   0,
	StateConnecting:       1,
	StateMediaNegotiating: 2,
	StateMediaReady:       3,
	StateActive:           4,
	StateTerminating:      5,
	StateTerminated:       6,
	StateFailed:           6,
}

var (
	ErrStateRegression = errors.New("session: state regression rejected")
	ErrTerminal        = errors.New("session: session already terminal")
	ErrUnknownState    = errors.New("session: unknown state")
)

func IsTerminal(s State) bool { return s == StateTerminated || s == StateFailed }

// Session is one media-plane call. It carries no tenant business data beyond
// the opaque identifiers supplied by the signed token.
type Session struct {
	mu sync.RWMutex

	ID            string
	CallID        string
	AgencyID      string // opaque; never used to make decisions here
	PhoneNumberID string
	CreatedAt     time.Time

	state          State
	stateChangedAt time.Time
	terminationRsn string

	inboundPackets  uint64
	outboundPackets uint64
	firstInboundAt  time.Time
	mediaReadyAt    time.Time
	mediaReadyFired bool
	outboundReady   bool
	iceConnected    bool
}

func New(id, callID, agencyID, phoneNumberID string, now time.Time) *Session {
	return &Session{
		ID: id, CallID: callID, AgencyID: agencyID, PhoneNumberID: phoneNumberID,
		CreatedAt: now, state: StateAuthenticating, stateChangedAt: now,
	}
}

func (s *Session) State() State {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state
}

func (s *Session) TerminationReason() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.terminationRsn
}

// Advance moves the session forward. Backwards moves are rejected, equal-rank
// repeats are no-ops, and terminal states absorb everything.
func (s *Session) Advance(next State, reason string, now time.Time) error {
	nr, ok := rank[next]
	if !ok {
		return ErrUnknownState
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if IsTerminal(s.state) {
		if s.state == next {
			return nil
		}
		return ErrTerminal
	}
	cur := rank[s.state]
	if nr < cur {
		return ErrStateRegression
	}
	if nr == cur && s.state != next {
		return ErrStateRegression
	}
	if s.state == next {
		return nil
	}
	s.state = next
	s.stateChangedAt = now
	if reason != "" {
		s.terminationRsn = reason
	}
	return nil
}

// MarkICEConnected records DTLS/ICE establishment. On its own this is NOT
// sufficient for media readiness.
func (s *Session) MarkICEConnected(now time.Time) {
	s.mu.Lock()
	s.iceConnected = true
	s.mu.Unlock()
}

// MarkOutboundReady records that a writable outbound RTP path exists.
func (s *Session) MarkOutboundReady() {
	s.mu.Lock()
	s.outboundReady = true
	s.mu.Unlock()
}

// RecordInbound counts a genuinely received RTP audio packet.
func (s *Session) RecordInbound(now time.Time) {
	s.mu.Lock()
	s.inboundPackets++
	if s.firstInboundAt.IsZero() {
		s.firstInboundAt = now
	}
	s.mu.Unlock()
}

func (s *Session) RecordOutbound() {
	s.mu.Lock()
	s.outboundPackets++
	s.mu.Unlock()
}

// MediaReadyRule is the single definition of readiness for the whole service:
// authenticated session + ICE/DTLS connected + real inbound RTP observed +
// outbound path available. SDP exchange, HTTP 200 and PeerConnection creation
// are explicitly not sufficient.
func (s *Session) MediaReadyRule() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.iceConnected && s.outboundReady && s.inboundPackets > 0 && !IsTerminal(s.state)
}

// TryFireMediaReady reports true exactly once, the first time the rule holds.
func (s *Session) TryFireMediaReady(now time.Time) bool {
	if !s.MediaReadyRule() {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.mediaReadyFired {
		return false
	}
	s.mediaReadyFired = true
	s.mediaReadyAt = now
	return true
}

// Stats is the log/metric-safe projection of a session. It contains no audio,
// no SDP, no transcripts and no credentials.
type Stats struct {
	SessionID       string    `json:"session_id"`
	CallID          string    `json:"call_id"`
	State           State     `json:"state"`
	CreatedAt       time.Time `json:"created_at"`
	StateChangedAt  time.Time `json:"state_changed_at"`
	InboundPackets  uint64    `json:"inbound_packets"`
	OutboundPackets uint64    `json:"outbound_packets"`
	MediaReadyAt    time.Time `json:"media_ready_at,omitzero"`
	Reason          string    `json:"termination_reason,omitempty"`
}

func (s *Session) Stats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return Stats{
		SessionID: s.ID, CallID: s.CallID, State: s.state,
		CreatedAt: s.CreatedAt, StateChangedAt: s.stateChangedAt,
		InboundPackets: s.inboundPackets, OutboundPackets: s.outboundPackets,
		MediaReadyAt: s.mediaReadyAt, Reason: s.terminationRsn,
	}
}
