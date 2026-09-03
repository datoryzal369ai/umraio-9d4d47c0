// Package health exposes the only two public, unauthenticated endpoints.
// It reports no secrets, no tenant data and no call identifiers.
package health

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
)

type Report struct {
	Status         string `json:"status"`
	WebRTC         string `json:"webrtc"`
	ActiveSessions int    `json:"active_sessions"`
	BuildVersion   string `json:"build_version"`
	// Speech is a capability signal only: "up" when the media plane can
	// synthesize the canonical voice, "down" otherwise. It never reveals a
	// credential, a provider response or any tenant data.
	Speech string `json:"speech"`
}

type Handler struct {
	Version        string
	WebRTCReady    *atomic.Bool
	ActiveSessions func() int
	Draining       *atomic.Bool
	SpeechReady    func() bool
}

func (h *Handler) Health(w http.ResponseWriter, _ *http.Request) {
	h.write(w, http.StatusOK)
}

func (h *Handler) Ready(w http.ResponseWriter, _ *http.Request) {
	code := http.StatusOK
	if h.Draining != nil && h.Draining.Load() {
		code = http.StatusServiceUnavailable
	}
	if h.WebRTCReady == nil || !h.WebRTCReady.Load() {
		code = http.StatusServiceUnavailable
	}
	h.write(w, code)
}

func (h *Handler) write(w http.ResponseWriter, code int) {
	r := Report{
		Status:       "ok",
		WebRTC:       "down",
		BuildVersion: h.Version,
	}
	if code != http.StatusOK {
		r.Status = "unavailable"
	}
	if h.WebRTCReady != nil && h.WebRTCReady.Load() {
		r.WebRTC = "up"
	}
	if h.ActiveSessions != nil {
		r.ActiveSessions = h.ActiveSessions()
	}
	r.Speech = "down"
	if h.SpeechReady != nil && h.SpeechReady() {
		r.Speech = "up"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(r)
}
