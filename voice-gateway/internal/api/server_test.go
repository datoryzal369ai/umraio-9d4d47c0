package api

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"

	"github.com/umraio/voice-gateway/internal/auth"
	"github.com/umraio/voice-gateway/internal/callback"
	"github.com/umraio/voice-gateway/internal/session"
	gwrtc "github.com/umraio/voice-gateway/internal/webrtc"
)

const secret = "0123456789abcdef0123456789abcdef0123456789"

type recorderEmitter struct {
	mu     sync.Mutex
	events []callback.Event
}

func (e *recorderEmitter) Send(_ context.Context, ev callback.Event) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, ev)
	return nil
}

func (e *recorderEmitter) names() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]string, 0, len(e.events))
	for _, ev := range e.events {
		out = append(out, ev.Event)
	}
	return out
}

func newServer(t *testing.T, maxConcurrent int) (*Server, *recorderEmitter, *http.ServeMux) {
	t.Helper()
	engine, err := gwrtc.NewEngine(gwrtc.Config{NegotiateTO: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	em := &recorderEmitter{}
	s := &Server{
		Secret:   secret,
		Engine:   engine,
		Registry: session.NewRegistry(maxConcurrent),
		Replay:   auth.NewReplayGuard(time.Minute),
		Events:   em,
		Logger:   slog.New(slog.NewTextHandler(discard{}, nil)),
	}
	mux := http.NewServeMux()
	s.Routes(mux)
	return s, em, mux
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func mintToken(t *testing.T, callID, nonce string, lifetime time.Duration) string {
	t.Helper()
	now := time.Now()
	tok, err := auth.Mint(secret, auth.Claims{
		CallID: callID, AgencyID: "ag_1", PhoneNumberID: "pn_1",
		IssuedAt: now.Unix(), ExpiresAt: now.Add(lifetime).Unix(),
		Nonce: nonce, Scope: auth.TokenScope,
	})
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func signedReq(t *testing.T, method, path, token string, body []byte) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	ts := time.Now().Unix()
	req.Header.Set(auth.TimestampHeader, strconv.FormatInt(ts, 10))
	req.Header.Set(auth.SignatureHeader, auth.SignRequest(secret, ts, body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req
}

func realOffer(t *testing.T) string {
	t.Helper()
	m := &pion.MediaEngine{}
	if err := m.RegisterCodec(pion.RTPCodecParameters{
		RTPCodecCapability: pion.RTPCodecCapability{
			MimeType: pion.MimeTypeOpus, ClockRate: 48000, Channels: 2,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		},
		PayloadType: 111,
	}, pion.RTPCodecTypeAudio); err != nil {
		t.Fatal(err)
	}
	pc, err := pion.NewAPI(pion.WithMediaEngine(m)).NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	track, err := pion.NewTrackLocalStaticSample(
		pion.RTPCodecCapability{MimeType: pion.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "caller")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pc.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather := pion.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gather:
	case <-time.After(10 * time.Second):
		t.Fatal("offer gathering timed out")
	}
	return pc.LocalDescription().SDP
}

func offerBody(t *testing.T, callID, sdp string) []byte {
	t.Helper()
	b, err := json.Marshal(OfferRequest{CallID: callID, SDPOffer: sdp, SDPType: "offer"})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestOfferRequiresRequestSignature(t *testing.T) {
	_, _, mux := newServer(t, 5)
	body := offerBody(t, "call-1", realOffer(t))
	req := httptest.NewRequest(http.MethodPost, "/v1/calls/offer", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+mintToken(t, "call-1", "n1", time.Minute))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without request signature, got %d", rr.Code)
	}
}

func TestOfferRejectsExpiredToken(t *testing.T) {
	_, _, mux := newServer(t, 5)
	now := time.Now().Add(-time.Hour)
	tok, _ := auth.Mint(secret, auth.Claims{
		CallID: "call-1", AgencyID: "ag_1", PhoneNumberID: "pn_1",
		IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix(),
		Nonce: "n1", Scope: auth.TokenScope,
	})
	body := offerBody(t, "call-1", realOffer(t))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, signedReq(t, http.MethodPost, "/v1/calls/offer", tok, body))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for expired token, got %d", rr.Code)
	}
}

func TestOfferRejectsCallIDMismatch(t *testing.T) {
	_, _, mux := newServer(t, 5)
	body := offerBody(t, "call-OTHER", realOffer(t))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, signedReq(t, http.MethodPost, "/v1/calls/offer", mintToken(t, "call-1", "n1", time.Minute), body))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for call_id mismatch, got %d", rr.Code)
	}
}

func TestOfferRejectsInvalidSDP(t *testing.T) {
	_, em, mux := newServer(t, 5)
	body := offerBody(t, "call-1", "definitely not sdp")
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, signedReq(t, http.MethodPost, "/v1/calls/offer", mintToken(t, "call-1", "n1", time.Minute), body))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid sdp, got %d", rr.Code)
	}
	for _, n := range em.names() {
		if n == callback.EventMediaReady {
			t.Fatal("media_ready must never be emitted for a rejected offer")
		}
	}
}

func TestOfferSucceedsAndDoesNotClaimMediaReady(t *testing.T) {
	s, em, mux := newServer(t, 5)
	body := offerBody(t, "call-1", realOffer(t))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, signedReq(t, http.MethodPost, "/v1/calls/offer", mintToken(t, "call-1", "n1", time.Minute), body))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	var resp OfferResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.SDPAnswer == "" || resp.SDPType != "answer" || resp.SessionID == "" {
		t.Fatalf("incomplete answer response: %+v", resp)
	}
	if resp.State != string(session.StateMediaNegotiating) {
		t.Fatalf("expected MEDIA_NEGOTIATING, got %s", resp.State)
	}
	time.Sleep(150 * time.Millisecond)
	for _, n := range em.names() {
		if n == callback.EventMediaReady {
			t.Fatal("HTTP 200 on offer must never imply media_ready")
		}
	}
	s.TerminateCall("call-1", "test_cleanup")
}

func TestOfferReplayIsRejected(t *testing.T) {
	s, _, mux := newServer(t, 5)
	tok := mintToken(t, "call-1", "n1", time.Minute)
	sdp := realOffer(t)

	rr1 := httptest.NewRecorder()
	mux.ServeHTTP(rr1, signedReq(t, http.MethodPost, "/v1/calls/offer", tok, offerBody(t, "call-1", sdp)))
	if rr1.Code != http.StatusOK {
		t.Fatalf("first offer failed: %d %s", rr1.Code, rr1.Body.String())
	}
	rr2 := httptest.NewRecorder()
	mux.ServeHTTP(rr2, signedReq(t, http.MethodPost, "/v1/calls/offer", tok, offerBody(t, "call-1", sdp)))
	if rr2.Code != http.StatusConflict {
		t.Fatalf("expected 409 for replayed token, got %d", rr2.Code)
	}
	s.TerminateCall("call-1", "test_cleanup")
}

func TestConcurrentSessionLimitEnforced(t *testing.T) {
	s, _, mux := newServer(t, 1)
	sdp := realOffer(t)
	rr1 := httptest.NewRecorder()
	mux.ServeHTTP(rr1, signedReq(t, http.MethodPost, "/v1/calls/offer", mintToken(t, "call-1", "n1", time.Minute), offerBody(t, "call-1", sdp)))
	if rr1.Code != http.StatusOK {
		t.Fatalf("first offer failed: %d", rr1.Code)
	}
	rr2 := httptest.NewRecorder()
	mux.ServeHTTP(rr2, signedReq(t, http.MethodPost, "/v1/calls/offer", mintToken(t, "call-2", "n2", time.Minute), offerBody(t, "call-2", realOffer(t))))
	if rr2.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 at capacity, got %d", rr2.Code)
	}
	s.TerminateCall("call-1", "test_cleanup")
}

func TestPerSessionRateLimit(t *testing.T) {
	s, _, _ := newServer(t, 5)
	now := time.Now()
	var limited bool
	for i := 0; i < 40; i++ {
		if err := s.Registry.Allow("call-1", now); err != nil {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("expected per-session rate limiting to engage")
	}
}

func TestBodySizeLimit(t *testing.T) {
	_, _, mux := newServer(t, 5)
	huge := make([]byte, MaxBodyBytes+2048)
	for i := range huge {
		huge[i] = 'a'
	}
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, signedReq(t, http.MethodPost, "/v1/calls/offer", mintToken(t, "call-1", "n1", time.Minute), huge))
	if rr.Code != http.StatusRequestEntityTooLarge && rr.Code != http.StatusBadRequest {
		t.Fatalf("expected oversized body rejection, got %d", rr.Code)
	}
}

func TestTerminateEndsSessionAndEmitsEvent(t *testing.T) {
	s, em, mux := newServer(t, 5)
	tok := mintToken(t, "call-1", "n1", time.Minute)
	rrOffer := httptest.NewRecorder()
	mux.ServeHTTP(rrOffer, signedReq(t, http.MethodPost, "/v1/calls/offer", tok, offerBody(t, "call-1", realOffer(t))))
	if rrOffer.Code != http.StatusOK {
		t.Fatalf("offer failed: %d", rrOffer.Code)
	}

	tok2 := mintToken(t, "call-1", "n2", time.Minute)
	body := []byte(`{"reason":"caller_hangup"}`)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, signedReq(t, http.MethodPost, "/v1/calls/call-1/terminate", tok2, body))
	if rr.Code != http.StatusOK {
		t.Fatalf("terminate failed: %d %s", rr.Code, rr.Body.String())
	}
	time.Sleep(200 * time.Millisecond)

	var sawTerminated bool
	for _, n := range em.names() {
		if n == callback.EventTerminated {
			sawTerminated = true
		}
	}
	if !sawTerminated {
		t.Fatalf("expected media_terminated event, got %v", em.names())
	}
	if s.Registry.Count() != 0 {
		t.Fatalf("session not released, count=%d", s.Registry.Count())
	}
}

func TestGetSessionRequiresAuth(t *testing.T) {
	_, _, mux := newServer(t, 5)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/calls/call-1", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestReapTerminatesStuckSessions(t *testing.T) {
	s, em, _ := newServer(t, 5)
	old := session.New("ms_old", "call-old", "ag", "pn", time.Now().Add(-time.Hour))
	if err := s.Registry.Add(old); err != nil {
		t.Fatal(err)
	}
	s.Reap(10*time.Minute, 30*time.Second)
	time.Sleep(150 * time.Millisecond)
	if s.Registry.Count() != 0 {
		t.Fatalf("stuck session not reaped, count=%d", s.Registry.Count())
	}
	if session.IsTerminal(old.State()) == false {
		t.Fatalf("reaped session should be terminal, got %s", old.State())
	}
	_ = em
}
