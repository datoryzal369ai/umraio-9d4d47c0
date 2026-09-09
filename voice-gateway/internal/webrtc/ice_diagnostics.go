package webrtc

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	pion "github.com/pion/webrtc/v4"
)

const iceDiagnosticInterval = 500 * time.Millisecond

// Published snapshots contain only owned, sanitized values. No Pion object,
// StatsReport, SDP, address or credential is retained. Teardown only loads this
// immutable cache; it never queries a PeerConnection or waits for the sampler.
type iceSnapshot struct {
	candidates                                           map[string][]any
	pairs                                                map[string]icePairObservation
	iceState, gatheringState, peerState, dtlsState, role string
}
type icePairObservation struct {
	local, remote, state                                   string
	requests, responses                                    uint64
	firstRequest, lastRequest, firstResponse, lastResponse int64
	selected, nominated                                    bool
}
type iceDiagnostics struct {
	ms              *MediaSession
	factory         *iceLogFactory
	mu              sync.Mutex // observation writers only; stop never acquires this lock
	state           iceSnapshot
	latest          atomic.Pointer[iceSnapshot]
	stopped         atomic.Bool
	stopCh          chan struct{}
	done            chan struct{}
	emitMu          sync.Mutex // diagnostic output only; teardown never waits on this lock
	firstReadyWrite atomic.Bool
	readyWrites     atomic.Uint64
}

func newICEDiagnostics(ms *MediaSession, factory *iceLogFactory) *iceDiagnostics {
	d := &iceDiagnostics{ms: ms, factory: factory, stopCh: make(chan struct{}), done: make(chan struct{}), state: iceSnapshot{
		candidates: map[string][]any{}, pairs: map[string]icePairObservation{}, iceState: "new", gatheringState: "new", peerState: "new", dtlsState: "new", role: "unknown",
	}}
	d.publishLocked()
	return d
}
func (d *iceDiagnostics) publishLocked() {
	if d.stopped.Load() {
		return
	}
	s := d.state
	s.candidates = make(map[string][]any, len(d.state.candidates))
	for k, v := range d.state.candidates {
		s.candidates[k] = v
	}
	s.pairs = make(map[string]icePairObservation, len(d.state.pairs))
	for k, v := range d.state.pairs {
		s.pairs[k] = v
	}
	d.latest.Store(&s)
}
func (d *iceDiagnostics) observeState(kind, value string) {
	if d.stopped.Load() {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	switch kind {
	case "ice":
		d.state.iceState = value
	case "gathering":
		d.state.gatheringState = value
	case "peer":
		d.state.peerState = value
	case "dtls":
		d.state.dtlsState = value
	}
	d.publishLocked()
}
func candidateObservation(side string, c ice.Candidate) []any {
	return []any{"candidate_id", diagnosticCandidateID(c.ID()), "side", side, "protocol", c.NetworkType().NetworkShort(), "family", addressFamily(c.Address()), "candidate_type", c.Type().String(), "port", c.Port(), "priority", c.Priority(), "foundation", safeFoundation(c.Foundation())}
}
func (d *iceDiagnostics) bindLocal(c *pion.ICECandidate) {
	if c == nil || d.stopped.Load() {
		return
	}
	// ToICE preserves Pion's opaque candidate ID. It does not access an agent,
	// gather candidates, send packets or alter the original candidate.
	local, err := c.ToICE()
	if err != nil {
		return
	}
	id := diagnosticCandidateID(local.ID())
	d.mu.Lock()
	if !d.stopped.Load() {
		d.state.candidates[id] = candidateObservation("local", local)
		d.publishLocked()
	}
	d.mu.Unlock()
	if !d.stopped.Load() {
		d.factory.owners.Store(id, d)
		if l, ok := d.factory.traces.Load(id); ok {
			l.(*sanitizedICELogger).attach(d)
		}
		if d.stopped.Load() {
			d.factory.owners.CompareAndDelete(id, d)
		}
	}
}
func (d *iceDiagnostics) observeTrace(r iceTraceRecord) {
	if d.stopped.Load() {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stopped.Load() {
		return
	}
	if r.role != "" {
		d.state.role = r.role
	}
	if len(r.local) > 1 {
		d.state.candidates[r.local[1].(string)] = r.local
	}
	if len(r.remote) > 1 {
		d.state.candidates[r.remote[1].(string)] = r.remote
	}
	event, fields := r.event, r.fields

	// Values come exclusively from the allowlisted trace adapter. Never inspect
	// its original Pion arguments here.
	var localID, remoteID string
	for i := 0; i+1 < len(fields); i += 2 {
		switch fields[i] {
		case "local_candidate":
			localID, _ = fields[i+1].(string)
		case "remote_candidate":
			remoteID, _ = fields[i+1].(string)
		}
	}
	if localID != "" && remoteID != "" {
		key := localID + "/" + remoteID
		p := d.state.pairs[key]
		p.local = localID
		p.remote = remoteID
		now := r.at
		switch event {
		case "check_request_attempt":
			p.requests++
			p.lastRequest = now
			if p.firstRequest == 0 {
				p.firstRequest = now
			}
			if p.state == "" {
				p.state = "in-progress"
			}
		case "pair_succeeded":
			p.state = "succeeded"
			p.responses++
			p.lastResponse = now
			if p.firstResponse == 0 {
				p.firstResponse = now
			}
		case "pair_check_limit_reached":
			p.state = "failed"
		case "pair_selected":
			p.selected = true
			p.nominated = true
			p.state = "succeeded"
		case "remote_nomination_accepted":
			p.nominated = true
		}
		d.state.pairs[key] = p
	}
	d.publishLocked()
}
func (d *iceDiagnostics) start() {
	if d.stopped.Load() {
		return
	}
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
func (d *iceDiagnostics) stop(_ string) {
	if d.stopped.Swap(true) {
		return
	}
	close(d.stopCh)
	cached := d.latest.Load()
	// Capture only gateway-owned counters, which use atomics/the session lock.
	// Disk/log-sink latency and any diagnostic writer can never delay ICE Close.
	in, out, ready := d.ms.inbound.Load(), d.ms.outbound.Load(), d.readyWrites.Load()
	mediaReady := !d.ms.sess.Stats().MediaReadyAt.IsZero()
	go func() {
		defer close(d.done)
		d.emitMu.Lock()
		defer d.emitMu.Unlock()
		d.emit(cached, "before_teardown", in, out, ready, mediaReady)
		d.ms.log.Info("ice diagnostic capture complete", "session_id", d.ms.sess.ID, "snapshot_source", "last_observed_before_teardown", "reason_source", "media session terminating", "pair_count", len(cached.pairs), "transport_ready_writes", ready)
		if d.factory != nil {
			d.factory.owners.Range(func(k, v any) bool {
				if v == d {
					d.factory.owners.CompareAndDelete(k, d)
					d.factory.traces.Delete(k)
				}
				return true
			})
		}
	}()
}
func (d *iceDiagnostics) snapshot(trigger string, _ bool) {
	d.emitMu.Lock()
	defer d.emitMu.Unlock()
	if d.stopped.Load() {
		return
	}
	d.emit(d.latest.Load(), trigger, d.ms.inbound.Load(), d.ms.outbound.Load(), d.readyWrites.Load(), !d.ms.sess.Stats().MediaReadyAt.IsZero())
}
func (d *iceDiagnostics) emit(s *iceSnapshot, trigger string, in, out, ready uint64, mediaReady bool) {
	keys := make([]string, 0, len(s.candidates))
	for k := range s.candidates {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		d.ms.log.Info("ice candidate observed", append([]any{"session_id", d.ms.sess.ID, "trigger", trigger}, s.candidates[k]...)...)
	}
	keys = keys[:0]
	for k := range s.pairs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		p := s.pairs[k]
		d.ms.log.Info("ice candidate pair observed", "session_id", d.ms.sess.ID, "trigger", trigger,
			"local_candidate", p.local, "remote_candidate", p.remote, "pair_state", p.state, "nominated", p.nominated, "selected", p.selected,
			"check_requests_attempted", p.requests, "check_responses_received", p.responses, "first_request_at_ms", p.firstRequest, "last_request_at_ms", p.lastRequest, "first_response_at_ms", p.firstResponse, "last_response_at_ms", p.lastResponse,
			"counter_source", "pion_ice_trace", "retransmits_available", false, "timeout_source", "ice check trace agent counter", "ice_role", s.role, "dtls_state", s.dtlsState)
	}
	d.ms.log.Info("ice session snapshot", "session_id", d.ms.sess.ID, "trigger", trigger, "snapshot_source", "last_observed_before_teardown",
		"ice_state", s.iceState, "gathering_state", s.gatheringState, "peer_state", s.peerState, "dtls_state", s.dtlsState, "ice_role", s.role, "media_ready", mediaReady,
		"inbound_rtp_packets", in, "local_opus_writes", out, "transport_ready_writes", ready, "pair_count", len(s.pairs), "retransmit_counter_supported", false)
}
func (ms *MediaSession) observeTransportReadyWrite(n uint64) {
	d := ms.diagnostics
	if d == nil || d.stopped.Load() {
		return
	}
	s := d.latest.Load()
	if s.peerState != "connected" || s.dtlsState != "connected" {
		return
	}
	count := d.readyWrites.Add(1)
	if d.firstReadyWrite.CompareAndSwap(false, true) {
		ms.log.Info("first outbound opus on ready transport", "session_id", ms.sess.ID, "local_opus_writes", n, "transport_ready_writes", count, "peer_state", "connected", "dtls_state", "connected", "evidence_scope", "successful_local_write_on_connected_transport", "remote_receipt_proven", false)
	}
}
