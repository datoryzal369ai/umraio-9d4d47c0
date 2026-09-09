package webrtc

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"sync/atomic"
	"syscall"

	"github.com/pion/ice/v4"
	"github.com/pion/logging"
)

// Candidate IDs are Pion-generated identifiers, NOT addresses or ICE credentials.
// A digest joins stats to trace events without exposing even those internal IDs.
func diagnosticCandidateID(id string) string {
	if id == "" {
		return "unavailable"
	}
	sum := sha256.Sum256([]byte(id))
	return fmt.Sprintf("c_%x", sum[:12])
}

type iceLogFactory struct {
	log      *slog.Logger
	fallback logging.LoggerFactory
	next     atomic.Uint64
}

func newICELogFactory(log *slog.Logger) *iceLogFactory {
	return &iceLogFactory{log: log, fallback: logging.NewDefaultLoggerFactory()}
}
func (f *iceLogFactory) NewLogger(scope string) logging.LeveledLogger {
	if scope != "ice" {
		return f.fallback.NewLogger(scope)
	}
	return &sanitizedICELogger{log: f.log, id: f.next.Add(1)}
}

type sanitizedICELogger struct {
	log      *slog.Logger
	id       uint64
	events   atomic.Uint64
	expired  atomic.Uint64
	failures atomic.Uint64
}

func (l *sanitizedICELogger) Trace(s string)            { l.observe(s) }
func (l *sanitizedICELogger) Debug(s string)            { l.observe(s) }
func (l *sanitizedICELogger) Info(s string)             { l.observe(s) }
func (l *sanitizedICELogger) Warn(s string)             { l.observe(s) }
func (l *sanitizedICELogger) Error(s string)            { l.observe(s) }
func (l *sanitizedICELogger) Tracef(s string, a ...any) { l.observe(s, a...) }
func (l *sanitizedICELogger) Debugf(s string, a ...any) { l.observe(s, a...) }
func (l *sanitizedICELogger) Infof(s string, a ...any)  { l.observe(s, a...) }
func (l *sanitizedICELogger) Warnf(s string, a ...any)  { l.observe(s, a...) }
func (l *sanitizedICELogger) Errorf(s string, a ...any) { l.observe(s, a...) }

// Match exact templates from the pinned Pion ICE v4.4.0 source. Never format
// a raw message or argument: several Pion debug templates contain ICE passwords.
// This receives existing log calls; it adds no STUN hooks, packets or retries.
func (l *sanitizedICELogger) observe(format string, args ...any) {
	event := ""
	fields := []any{"ice_trace_id", l.id}
	candidates := func(a, b int) {
		if len(args) <= a || len(args) <= b {
			return
		}
		local, lok := args[a].(ice.Candidate)
		remote, rok := args[b].(ice.Candidate)
		if lok && rok {
			fields = append(fields, "local_candidate", diagnosticCandidateID(local.ID()), "remote_candidate", diagnosticCandidateID(remote.ID()))
			fields = append(fields, traceCandidateAttrs("local", local)...)
			fields = append(fields, traceCandidateAttrs("remote", remote)...)
		}
	}
	pair := func() {
		if len(args) == 0 {
			return
		}
		if p, ok := args[0].(*ice.CandidatePair); ok && p != nil {
			fields = append(fields, "local_candidate", diagnosticCandidateID(p.Local.ID()), "remote_candidate", diagnosticCandidateID(p.Remote.ID()))
		}
	}
	inbound := func() {
		if len(args) < 2 {
			return
		}
		if local, ok := args[1].(ice.Candidate); ok {
			fields = append(fields, "local_candidate", diagnosticCandidateID(local.ID()))
			fields = append(fields, traceCandidateAttrs("local", local)...)
		}
		if remote, ok := args[0].(netip.AddrPort); ok {
			family := "ipv6"
			if remote.Addr().Is4() {
				family = "ipv4"
			}
			fields = append(fields, "remote_family", family, "remote_port", remote.Port())
		}
	}
	switch format {
	case "Started agent: isControlling? %t, remoteUfrag: %q, remotePwd: %q":
		if len(args) < 1 {
			return
		}
		controlling, ok := args[0].(bool)
		if !ok {
			return
		}
		role := "controlled"
		if controlling {
			role = "controlling"
		}
		event = "agent_started"
		fields = append(fields, "ice_role", role, "nomination_mode", "regular", "nomination_mode_source", "pinned_pion_default")
	case "Ping STUN from %s to %s":
		event = "check_request_attempt"
		candidates(0, 1)
	case "Ping STUN (nominate candidate pair) from %s to %s":
		event = "nomination_request"
		candidates(0, 1)
	case "Inbound STUN (SuccessResponse) from %s to %s":
		event = "check_success_response"
		inbound()
	case "Inbound STUN (Request) from %s to %s, useCandidate: %v":
		event = "check_request_received"
		inbound()
		if len(args) > 2 {
			if use, ok := args[2].(bool); ok {
				fields = append(fields, "use_candidate", use)
			}
		}
	case "Found valid candidate pair: %s":
		event = "pair_succeeded"
		pair()
	case "Maximum requests reached for pair %s, marking it as failed":
		event = "pair_check_limit_reached"
		pair()
	case "Set selected candidate pair: %s":
		event = "pair_selected"
		pair()
	case "Accepting nomination for pair %s":
		event = "remote_nomination_accepted"
		pair()
	case "Discarded %d binding requests because they expired":
		if len(args) == 0 {
			return
		}
		n, ok := args[0].(int)
		if !ok || n < 0 {
			return
		}
		event = "binding_transactions_expired"
		fields = append(fields, "expired_count", n, "expired_total", l.expired.Add(uint64(n)), "counter_scope", "ice_agent")
	case "Failed to send STUN message: %s":
		event = "stun_socket_send_error"
		kind := "unclassified"
		if len(args) > 0 {
			if e, ok := args[0].(error); ok {
				kind = stunErrorClass(e)
			}
		}
		fields = append(fields, "error_class", kind, "transaction_failures", l.failures.Add(1), "counter_scope", "ice_agent")
	case "Discard success response with broken integrity from (%s), %v", "Discard request with broken integrity from (%s), %v":
		event = "stun_integrity_rejected"
	case "Discard request with wrong username from (%s), %v":
		event = "stun_username_rejected"
	case "Discard success response from (%s), unknown TransactionID 0x%x", "Discard message from (%s), unknown TransactionID 0x%x":
		event = "stun_unknown_transaction"
	case "Role conflict local and remote same role(%s), localIsGreaterOrEqual(%t)":
		event = "ice_role_conflict"
	case "Discard message: transaction source and destination does not match expected(%s), actual(%s)":
		event = "stun_transaction_source_mismatch"
	case "Failed to ping without candidate pairs. Connection is not possible yet.":
		event = "checklist_empty"
	default:
		return
	}
	// Bound verbosity per ICE logger. Counters above continue even at the cap.
	n := l.events.Add(1)
	if n > 4096 {
		if n == 4097 {
			l.log.Warn("ice trace truncated", "ice_trace_id", l.id, "event_limit", 4096)
		}
		return
	}
	fields = append(fields, "event", event)
	l.log.Info("ice check trace", fields...)
}
func traceCandidateAttrs(prefix string, c ice.Candidate) []any {
	// Numeric foundations are safe to retain; arbitrary remote foundation text
	// is not. Candidate extensions/username/address are deliberately never read.
	foundation := "unavailable"
	if n, err := strconv.ParseUint(c.Foundation(), 10, 32); err == nil {
		foundation = strconv.FormatUint(n, 10)
	}
	return []any{prefix + "_protocol", c.NetworkType().NetworkShort(), prefix + "_family", addressFamily(c.Address()), prefix + "_type", c.Type().String(), prefix + "_port", c.Port(), prefix + "_priority", c.Priority(), prefix + "_foundation", foundation}
}
func stunErrorClass(err error) string {
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection_refused"
	case errors.Is(err, syscall.ENETUNREACH):
		return "network_unreachable"
	case errors.Is(err, syscall.EHOSTUNREACH):
		return "host_unreachable"
	case errors.Is(err, syscall.EADDRNOTAVAIL):
		return "address_unavailable"
	case errors.Is(err, net.ErrClosed):
		return "socket_closed"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	return "unclassified"
}
