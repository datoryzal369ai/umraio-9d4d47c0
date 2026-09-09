package webrtc

import (
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	pion "github.com/pion/webrtc/v4"
)

// A separate sampler reads public Pion stats. It never runs on the RTP path,
// schedules connectivity checks, changes deadlines, or controls session state.
// Transient checklist states can fall between samples: trace events supplement
// those samples, and absence of an observed state is never reported as failure.
const iceDiagnosticInterval = 500 * time.Millisecond

type iceDiagnostics struct {
	ms              *MediaSession
	mu              sync.Mutex
	stopped         bool
	stopCh          chan struct{}
	candidates      map[string]bool
	pairs           map[string]string
	firstReadyWrite atomic.Bool
	readyWrites     atomic.Uint64
}

func newICEDiagnostics(ms *MediaSession) *iceDiagnostics {
	return &iceDiagnostics{ms: ms, stopCh: make(chan struct{}), candidates: map[string]bool{}, pairs: map[string]string{}}
}
func (d *iceDiagnostics) start() {
	d.mu.Lock()
	if d.stopped {
		d.mu.Unlock()
		return
	}
	d.mu.Unlock()
	d.snapshot("attached", false)
	go func() {
		ticker := time.NewTicker(iceDiagnosticInterval)
		defer ticker.Stop()
		for {
			select {
			case <-d.stopCh:
				return
			case <-ticker.C:
				d.snapshot("sample", false)
			}
		}
	}()
}
func (d *iceDiagnostics) stop(reason string) {
	d.mu.Lock()
	if d.stopped {
		d.mu.Unlock()
		return
	}
	d.stopped = true
	close(d.stopCh)
	d.capture("before_teardown", true)
	// The existing lifecycle log carries the reason; do not copy arbitrary input
	// into the new diagnostic schema.
	d.ms.log.Info("ice diagnostic capture complete", "session_id", d.ms.sess.ID, "reason_source", "media session terminating", "pair_count", len(d.pairs), "transport_ready_writes", d.readyWrites.Load())
	d.mu.Unlock()
}
func (d *iceDiagnostics) snapshot(trigger string, force bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stopped {
		return
	}
	d.capture(trigger, force)
}
func (d *iceDiagnostics) capture(trigger string, force bool) {
	report := d.ms.pc.GetStats()
	keys := make([]string, 0, len(report))
	for k := range report {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if c, ok := report[k].(pion.ICECandidateStats); ok {
			if d.candidates[c.ID] && !force {
				continue
			}
			d.candidates[c.ID] = true
			side := "remote"
			if c.Type == pion.StatsTypeLocalCandidate {
				side = "local"
			}
			protocol := "unknown"
			if c.Protocol == "udp" || c.Protocol == "tcp" {
				protocol = c.Protocol
			}
			d.ms.log.Info("ice candidate observed", "session_id", d.ms.sess.ID, "trigger", trigger, "candidate_id", diagnosticCandidateID(c.ID), "side", side, "protocol", protocol, "family", addressFamily(c.IP), "candidate_type", c.CandidateType.String(), "port", c.Port, "priority", uint32(c.Priority), "foundation_source", "ice check trace when available")
		}
	}
	dtls := "unavailable"
	role := "unavailable"
	selected := ""
	if s := d.ms.pc.SCTP(); s != nil && s.Transport() != nil {
		dtls = s.Transport().State().String()
		if t := s.Transport().ICETransport(); t != nil {
			role = t.Role().String()
			if p, ok := t.GetSelectedCandidatePairStats(); ok {
				selected = p.LocalCandidateID + "/" + p.RemoteCandidateID
			}
		}
	}
	for _, k := range keys {
		p, ok := report[k].(pion.ICECandidatePairStats)
		if !ok {
			continue
		}
		pairID := p.LocalCandidateID + "/" + p.RemoteCandidateID
		isSelected := selected == pairID
		signature := fmt.Sprintf("%s/%t/%t/%d/%d/%d/%d", p.State, p.Nominated, isSelected, p.RequestsSent, p.ResponsesReceived, p.RequestsReceived, p.ResponsesSent)
		if d.pairs[pairID] == signature && !force {
			continue
		}
		d.pairs[pairID] = signature
		d.ms.log.Info("ice candidate pair observed", "session_id", d.ms.sess.ID, "trigger", trigger,
			"local_candidate", diagnosticCandidateID(p.LocalCandidateID), "remote_candidate", diagnosticCandidateID(p.RemoteCandidateID),
			"pair_state", string(p.State), "nominated", p.Nominated, "selected", isSelected,
			"check_requests_attempted", p.RequestsSent, "check_responses_received", p.ResponsesReceived,
			"check_requests_received", p.RequestsReceived, "check_responses_sent", p.ResponsesSent,
			"first_request_at_ms", p.FirstRequestTimestamp, "last_request_at_ms", p.LastRequestTimestamp,
			"first_response_at_ms", p.FirstResponseTimestamp, "last_response_at_ms", p.LastResponseTimestamp,
			"retransmits_available", false, "timeout_source", "ice check trace agent counter",
			"pair_packets_sent", p.PacketsSent, "pair_packets_received", p.PacketsReceived,
			"packet_scope", "ice_transport_includes_dtls_not_rtp_only", "ice_role", role, "dtls_state", dtls,
			"observation_interval_ms", iceDiagnosticInterval.Milliseconds())
	}
	// Always capture the final pre-close state, including an empty checklist.
	if force || trigger == "attached" {
		st := d.ms.sess.Stats()
		d.ms.log.Info("ice session snapshot", "session_id", d.ms.sess.ID, "trigger", trigger,
			"ice_state", d.ms.pc.ICEConnectionState().String(), "gathering_state", d.ms.pc.ICEGatheringState().String(), "peer_state", d.ms.pc.ConnectionState().String(),
			"dtls_state", dtls, "ice_role", role, "media_ready", !st.MediaReadyAt.IsZero(), "inbound_rtp_packets", d.ms.inbound.Load(), "local_opus_writes", d.ms.outbound.Load(),
			"transport_ready_writes", d.readyWrites.Load(), "pair_count", len(d.pairs), "retransmit_counter_supported", false)
	}
}
func (ms *MediaSession) observeTransportReadyWrite(n uint64) {
	d := ms.diagnostics
	if d == nil || ms.pc.ConnectionState() != pion.PeerConnectionStateConnected {
		return
	}
	t := ms.pc.SCTP()
	if t == nil || t.Transport() == nil || t.Transport().State() != pion.DTLSTransportStateConnected {
		return
	}
	count := d.readyWrites.Add(1)
	if d.firstReadyWrite.CompareAndSwap(false, true) {
		ms.log.Info("first outbound opus on ready transport", "session_id", ms.sess.ID, "local_opus_writes", n, "transport_ready_writes", count, "peer_state", "connected", "dtls_state", "connected", "evidence_scope", "successful_local_write_on_connected_transport", "remote_receipt_proven", false)
	}
}
