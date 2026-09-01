package session

import (
	"errors"
	"sync"
	"time"
)

var (
	ErrCapacity  = errors.New("session: maximum concurrent sessions reached")
	ErrDuplicate = errors.New("session: call already has a live media session")
	ErrNotFound  = errors.New("session: not found")
	ErrRateLimit = errors.New("session: per-session rate limit exceeded")
)

// Registry tracks live media sessions, enforces the concurrency ceiling and
// keeps one call_id bound to at most one media session.
type Registry struct {
	mu       sync.Mutex
	byID     map[string]*Session
	byCall   map[string]*Session
	ops      map[string][]time.Time
	max      int
	opWindow time.Duration
	opLimit  int
}

func NewRegistry(max int) *Registry {
	if max <= 0 {
		max = 25
	}
	return &Registry{
		byID: map[string]*Session{}, byCall: map[string]*Session{},
		ops: map[string][]time.Time{}, max: max,
		opWindow: time.Minute, opLimit: 30,
	}
}

func (r *Registry) Add(s *Session) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.byCall[s.CallID]; dup {
		return ErrDuplicate
	}
	if len(r.byID) >= r.max {
		return ErrCapacity
	}
	r.byID[s.ID] = s
	r.byCall[s.CallID] = s
	return nil
}

func (r *Registry) ByCall(callID string) (*Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.byCall[callID]
	if !ok {
		return nil, ErrNotFound
	}
	return s, nil
}

func (r *Registry) Remove(callID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.byCall[callID]; ok {
		delete(r.byID, s.ID)
		delete(r.byCall, callID)
	}
	delete(r.ops, callID)
}

func (r *Registry) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.byID)
}

// Allow applies a sliding-window rate limit keyed on call_id, covering every
// control operation aimed at one session.
func (r *Registry) Allow(callID string, now time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	cutoff := now.Add(-r.opWindow)
	kept := r.ops[callID][:0]
	for _, t := range r.ops[callID] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= r.opLimit {
		r.ops[callID] = kept
		return ErrRateLimit
	}
	r.ops[callID] = append(kept, now)
	return nil
}

// Expired lists sessions past the supplied lifetime or stuck before readiness.
func (r *Registry) Expired(now time.Time, maxDuration, negotiateTimeout time.Duration) []*Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []*Session
	for _, s := range r.byID {
		st := s.Stats()
		if IsTerminal(st.State) {
			out = append(out, s)
			continue
		}
		if now.Sub(st.CreatedAt) > maxDuration {
			out = append(out, s)
			continue
		}
		if st.MediaReadyAt.IsZero() && now.Sub(st.CreatedAt) > negotiateTimeout {
			out = append(out, s)
		}
	}
	return out
}
