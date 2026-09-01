package auth

import (
	"sync"
	"time"
)

// ReplayGuard burns a (call_id, nonce) pair exactly once. Session tokens are
// single-call scoped, so a second presentation of the same nonce — or a second
// offer for the same call_id — is rejected.
type ReplayGuard struct {
	mu      sync.Mutex
	seen    map[string]time.Time
	ttl     time.Duration
	nowFunc func() time.Time
}

func NewReplayGuard(ttl time.Duration) *ReplayGuard {
	if ttl <= 0 {
		ttl = MaxTokenLifetime * 2
	}
	return &ReplayGuard{seen: make(map[string]time.Time), ttl: ttl, nowFunc: time.Now}
}

// SetClock is test-only injection.
func (g *ReplayGuard) SetClock(f func() time.Time) { g.nowFunc = f }

// Use records the nonce. It returns ErrReplayed if the pair was already used.
func (g *ReplayGuard) Use(callID, nonce string) error {
	key := callID + "|" + nonce
	now := g.nowFunc()
	g.mu.Lock()
	defer g.mu.Unlock()
	g.evictLocked(now)
	if _, dup := g.seen[key]; dup {
		return ErrReplayed
	}
	g.seen[key] = now.Add(g.ttl)
	return nil
}

// Size reports live entries (observability/tests only).
func (g *ReplayGuard) Size() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.evictLocked(g.nowFunc())
	return len(g.seen)
}

func (g *ReplayGuard) evictLocked(now time.Time) {
	for k, exp := range g.seen {
		if now.After(exp) {
			delete(g.seen, k)
		}
	}
}
