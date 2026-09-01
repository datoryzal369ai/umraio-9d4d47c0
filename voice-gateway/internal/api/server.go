// Package api is the signalling surface of the media gateway. It authenticates
// every control-plane request, enforces limits, and delegates media work to the
// webrtc package. It makes no business decisions.
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/umraio/voice-gateway/internal/auth"
	"github.com/umraio/voice-gateway/internal/callback"
	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/session"
	gwrtc "github.com/umraio/voice-gateway/internal/webrtc"
)

// MaxBodyBytes bounds any control-plane request body.
const MaxBodyBytes = 64 * 1024

type OfferRequest struct {
	CallID   string `json:"call_id"`
	SDPOffer string `json:"sdp_offer"`
	SDPType  string `json:"sdp_type"`
}

type OfferResponse struct {
	SessionID string `json:"session_id"`
	SDPAnswer string `json:"sdp_answer"`
	SDPType   string `json:"sdp_type"`
	State     string `json:"state"`
}

type TerminateRequest struct {
	Reason string `json:"reason"`
}

// Emitter delivers lifecycle events to the control plane.
type Emitter interface {
	Send(ctx context.Context, ev callback.Event) error
}

type Server struct {
	Secret   string
	Engine   *gwrtc.Engine
	Registry *session.Registry
	Replay   *auth.ReplayGuard
	Events   Emitter
	Logger   *slog.Logger
	Now      func() time.Time
	// NewPipeline builds the (future) ASR/TTS pipeline for a session.
	// Phase 1 returns a no-op pipeline.
	NewPipeline func(callID string) umedia.Pipeline

	mu    sync.Mutex
	media map[string]*gwrtc.MediaSession
}

func (s *Server) init() {
	if s.Now == nil {
		s.Now = time.Now
	}
	if s.Logger == nil {
		s.Logger = slog.Default()
	}
	if s.NewPipeline == nil {
		s.NewPipeline = func(string) umedia.Pipeline { return &umedia.NoopPipeline{} }
	}
	if s.media == nil {
		s.media = map[string]*gwrtc.MediaSession{}
	}
}

func (s *Server) Routes(mux *http.ServeMux) {
	s.init()
	mux.HandleFunc("POST /v1/calls/offer", s.handleOffer)
	mux.HandleFunc("POST /v1/calls/{callID}/terminate", s.handleTerminate)
	mux.HandleFunc("GET /v1/calls/{callID}", s.handleGet)
}

// authenticate validates the request HMAC and the single-call session token.
// It returns the verified claims; the gateway trusts nothing else in the body.
func (s *Server) authenticate(r *http.Request, body []byte, expectedCallID string) (auth.Claims, error) {
	if err := auth.VerifyRequest(s.Secret, r.Header.Get(auth.SignatureHeader), r.Header.Get(auth.TimestampHeader), body, s.Now()); err != nil {
		return auth.Claims{}, err
	}
	raw := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(raw, "Bearer ") {
		return auth.Claims{}, auth.ErrMalformedToken
	}
	return auth.Verify(s.Secret, strings.TrimPrefix(raw, "Bearer "), expectedCallID, s.Now())
}

func (s *Server) handleOffer(w http.ResponseWriter, r *http.Request) {
	s.init()
	body, err := readBody(r)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "body_too_large")
		return
	}
	var req OfferRequest
	if err := json.Unmarshal(body, &req); err != nil || req.CallID == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if req.SDPType != "" && req.SDPType != "offer" {
		writeErr(w, http.StatusBadRequest, "invalid_sdp_type")
		return
	}
	claims, err := s.authenticate(r, body, req.CallID)
	if err != nil {
		s.Logger.Warn("offer rejected", "error_class", errClass(err), "call_id", req.CallID)
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := s.Registry.Allow(claims.CallID, s.Now()); err != nil {
		writeErr(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	// Single-call scoped token: burn the nonce before any media work.
	if err := s.Replay.Use(claims.CallID, claims.Nonce); err != nil {
		writeErr(w, http.StatusConflict, "replayed")
		return
	}
	if err := gwrtc.ValidateOffer(req.SDPOffer); err != nil {
		s.Logger.Warn("sdp rejected", "error_class", errClass(err), "call_id", claims.CallID)
		writeErr(w, http.StatusBadRequest, "invalid_sdp")
		return
	}

	sess := session.New(newID(), claims.CallID, claims.AgencyID, claims.PhoneNumberID, s.Now())
	if err := s.Registry.Add(sess); err != nil {
		switch {
		case errors.Is(err, session.ErrCapacity):
			writeErr(w, http.StatusServiceUnavailable, "at_capacity")
		case errors.Is(err, session.ErrDuplicate):
			writeErr(w, http.StatusConflict, "duplicate_session")
		default:
			writeErr(w, http.StatusInternalServerError, "registry_error")
		}
		return
	}

	hooks := gwrtc.Hooks{
		OnMediaReady: func(sn *session.Session) { s.emit(callback.EventMediaReady, sn, "") },
		OnTerminated: func(sn *session.Session, reason string) {
			s.emit(callback.EventTerminated, sn, reason)
			s.forget(sn.CallID)
		},
	}

	answer, ms, err := s.Engine.Establish(r.Context(), sess, req.SDPOffer, s.NewPipeline(claims.CallID), hooks)
	if err != nil {
		_ = sess.Advance(session.StateFailed, "negotiation_failed", s.Now())
		s.emit(callback.EventMediaFailed, sess, "negotiation_failed")
		s.Registry.Remove(sess.CallID)
		s.Logger.Warn("negotiation failed", "error_class", errClass(err), "error_detail", safeErrorDetail(err), "call_id", claims.CallID, "session_id", sess.ID)
		writeErr(w, http.StatusBadGateway, "negotiation_failed")
		return
	}

	s.mu.Lock()
	s.media[sess.CallID] = ms
	s.mu.Unlock()

	s.emit(callback.EventNegotiating, sess, "")
	s.Logger.Info("media negotiating", "call_id", sess.CallID, "session_id", sess.ID, "state", string(sess.State()))

	writeJSON(w, http.StatusOK, OfferResponse{
		SessionID: sess.ID, SDPAnswer: answer, SDPType: "answer", State: string(sess.State()),
	})
}

func (s *Server) handleTerminate(w http.ResponseWriter, r *http.Request) {
	s.init()
	callID := r.PathValue("callID")
	body, err := readBody(r)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "body_too_large")
		return
	}
	claims, err := s.authenticate(r, body, callID)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := s.Registry.Allow(claims.CallID, s.Now()); err != nil {
		writeErr(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	var req TerminateRequest
	_ = json.Unmarshal(body, &req)
	reason := req.Reason
	if reason == "" {
		reason = "control_plane_terminate"
	}
	s.TerminateCall(claims.CallID, reason)
	writeJSON(w, http.StatusOK, map[string]string{"call_id": claims.CallID, "reason": reason})
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	s.init()
	callID := r.PathValue("callID")
	if _, err := s.authenticate(r, nil, callID); err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	sess, err := s.Registry.ByCall(callID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}
	writeJSON(w, http.StatusOK, sess.Stats())
}

// TerminateCall is idempotent and safe from the reaper or the control plane.
func (s *Server) TerminateCall(callID, reason string) {
	s.mu.Lock()
	ms := s.media[callID]
	s.mu.Unlock()
	if ms != nil {
		ms.Terminate(reason)
		return
	}
	if sess, err := s.Registry.ByCall(callID); err == nil {
		_ = sess.Advance(session.StateTerminating, reason, s.Now())
		_ = sess.Advance(session.StateTerminated, reason, s.Now())
		s.emit(callback.EventTerminated, sess, reason)
		s.Registry.Remove(callID)
	}
}

// Reap enforces max call duration and negotiation timeouts.
func (s *Server) Reap(maxDuration, negotiateTimeout time.Duration) {
	s.init()
	for _, sess := range s.Registry.Expired(s.Now(), maxDuration, negotiateTimeout) {
		reason := "session_timeout"
		if session.IsTerminal(sess.State()) {
			reason = sess.TerminationReason()
		}
		s.TerminateCall(sess.CallID, reason)
		s.forget(sess.CallID)
	}
}

func (s *Server) forget(callID string) {
	s.mu.Lock()
	delete(s.media, callID)
	s.mu.Unlock()
	s.Registry.Remove(callID)
}

func (s *Server) emit(name string, sess *session.Session, reason string) {
	if s.Events == nil {
		return
	}
	st := sess.Stats()
	ev := callback.Event{
		Event: name, CallID: st.CallID, SessionID: st.SessionID,
		Timestamp:      s.Now().UTC().Format(time.RFC3339Nano),
		InboundPackets: st.InboundPackets, OutboundPackets: st.OutboundPackets,
		Reason: reason,
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := s.Events.Send(ctx, ev); err != nil {
			s.Logger.Warn("callback failed", "error_class", errClass(err), "call_id", ev.CallID, "event", name)
		}
	}()
}

func readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	return io.ReadAll(http.MaxBytesReader(nil, r.Body, MaxBodyBytes))
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, class string) {
	writeJSON(w, code, map[string]string{"error": class})
}

// errClass keeps logs free of SDP, audio, tokens and transcripts.
func errClass(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if i := strings.Index(msg, ":"); i > 0 {
		return msg[:i]
	}
	return "error"
}

var (
	reHexPairs  = regexp.MustCompile(`(?i)([0-9a-f]{2}:){3,}[0-9a-f]{2}`) // DTLS fingerprints
	reIPv4      = regexp.MustCompile(`\b\d{1,3}(\.\d{1,3}){3}\b`)
	reLongToken = regexp.MustCompile(`[A-Za-z0-9+/=_-]{12,}`) // ufrag, pwd, tokens, signatures
	reNumber    = regexp.MustCompile(`\+?\d[\d\s-]{6,}\d`)  // phone-like sequences
)

// safeErrorDetail returns the underlying parser/validation reason from an
// error with SDP lines, fingerprints, ICE credentials, IPs, tokens and
// phone-like numbers stripped. It never emits raw SDP or credentials.
func safeErrorDetail(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	// Drop the class prefix; errClass already carries it.
	msg = strings.TrimPrefix(msg, errClass(err)+": ")
	// Drop any SDP line (e.g. "a=...", "m=...") that may be embedded.
	lines := strings.Split(msg, "\n")
	keep := lines[:0]
	for _, ln := range lines {
		t := strings.TrimSpace(ln)
		if len(t) >= 2 && t[1] == '=' {
			continue
		}
		keep = append(keep, ln)
	}
	msg = strings.Join(keep, " ")
	msg = reHexPairs.ReplaceAllString(msg, "[redacted]")
	msg = reIPv4.ReplaceAllString(msg, "[redacted-ip]")
	msg = reLongToken.ReplaceAllString(msg, "[redacted]")
	msg = reNumber.ReplaceAllString(msg, "[redacted-number]")
	msg = strings.Join(strings.Fields(msg), " ")
	if len(msg) > 160 {
		msg = msg[:160]
	}
	return msg
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "ms_" + hex.EncodeToString(b)
}
