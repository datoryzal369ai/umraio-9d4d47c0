package api

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/umraio/voice-gateway/internal/auth"
	"github.com/umraio/voice-gateway/internal/session"
	gwrtc "github.com/umraio/voice-gateway/internal/webrtc"
)

// bufLog is a slog sink the test can inspect after the request completes.
type bufLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *bufLog) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *bufLog) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// sdpBadPort passes ValidateOffer but fails inside Pion at SetRemoteDescription.
// It deliberately embeds marker values that must never appear in logs.
const (
	probeFingerprint = "00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF"
	probeUfrag       = "supersecretufrag123456"
	probePwd         = "verysecreticepassword987654321"
	probePort        = "notaport"
)

var sdpBadPort = "v=0\r\n" +
	"o=- 1 1 IN IP4 0.0.0.0\r\n" +
	"s=-\r\n" +
	"t=0 0\r\n" +
	"m=audio " + probePort + " UDP/TLS/RTP/SAVPF 111\r\n" +
	"c=IN IP4 0.0.0.0\r\n" +
	"a=rtpmap:111 opus/48000/2\r\n" +
	"a=fingerprint:sha-256 " + probeFingerprint + "\r\n" +
	"a=ice-ufrag:" + probeUfrag + "\r\n" +
	"a=ice-pwd:" + probePwd + "\r\n" +
	"a=setup:actpass\r\n" +
	"a=mid:0\r\n"

func negotiationFailureLogs(t *testing.T) (int, string) {
	t.Helper()
	engine, err := gwrtc.NewEngine(gwrtc.Config{NegotiateTO: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	logs := &bufLog{}
	s := &Server{
		Secret:   secret,
		Engine:   engine,
		Registry: session.NewRegistry(5),
		Replay:   auth.NewReplayGuard(time.Minute),
		Logger:   slog.New(slog.NewTextHandler(logs, nil)),
	}
	mux := http.NewServeMux()
	s.Routes(mux)

	tok := mintToken(t, "call-diag", "ndiag", time.Minute)
	body := offerBody(t, "call-diag", sdpBadPort)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, signedReq(t, http.MethodPost, "/v1/calls/offer", tok, body))
	return rr.Code, logs.String()
}

func TestNegotiationFailureReturns502(t *testing.T) {
	code, _ := negotiationFailureLogs(t)
	if code != http.StatusBadGateway {
		t.Fatalf("expected 502 for negotiation failure, got %d", code)
	}
}

func TestNegotiationFailureLogsErrorClassUnchanged(t *testing.T) {
	_, out := negotiationFailureLogs(t)
	if !strings.Contains(out, `error_class="set remote description"`) {
		t.Fatalf("error_class changed or missing, logs: %s", out)
	}
}

func TestNegotiationFailureLogsSafeErrorDetail(t *testing.T) {
	_, out := negotiationFailureLogs(t)
	if !strings.Contains(out, "error_detail=") {
		t.Fatalf("error_detail field missing, logs: %s", out)
	}
	// The underlying parser reason must be preserved.
	if !strings.Contains(out, "invalid port value") {
		t.Fatalf("underlying Pion reason not preserved, logs: %s", out)
	}
}

func TestNegotiationFailureLogsNoSensitiveMaterial(t *testing.T) {
	_, out := negotiationFailureLogs(t)
	for _, forbidden := range []string{
		probeFingerprint,                       // DTLS fingerprint
		probeUfrag,                             // ICE ufrag
		probePwd,                               // ICE pwd
		probePort,                              // raw SDP-derived value
		"opus/48000",                           // SDP media description
		"a=rtpmap", "m=audio", "a=fingerprint", // SDP lines
		secret,    // shared secret / HMAC key
		"0.0.0.0", // IP address
	} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("logs leak %q; full logs: %s", forbidden, out)
		}
	}
}

func TestNegotiationFailureLogsNoAuthMaterial(t *testing.T) {
	tok := mintToken(t, "call-diag", "ndiag", time.Minute)
	code, out := negotiationFailureLogs(t)
	if code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", code)
	}
	if strings.Contains(out, tok) {
		t.Fatalf("logs contain the bearer token: %s", out)
	}
	// HMAC signature sent on the request must never be logged.
	body := offerBody(t, "call-diag", sdpBadPort)
	ts := time.Now().Unix()
	sig := auth.SignRequest(secret, ts, body)
	if strings.Contains(out, sig) {
		t.Fatalf("logs contain the request HMAC signature: %s", out)
	}
}

func TestSafeErrorDetailStripsSDPLinesAndCredentials(t *testing.T) {
	raw := "set remote description: failed to unmarshal SDP: sdp: bad line `a=ice-ufrag:abc123def456ghi789` near 10.0.0.1 fingerprint AA:BB:CC:DD:EE:FF:00:11 token abcdef0123456789abcdef"
	detail := safeErrorDetail(errString(raw))
	for _, forbidden := range []string{
		"a=ice-ufrag", "abc123def456ghi789", "10.0.0.1",
		"AA:BB:CC:DD", "abcdef0123456789abcdef",
	} {
		if strings.Contains(detail, forbidden) {
			t.Fatalf("detail leaks %q: %q", forbidden, detail)
		}
	}
	if !strings.Contains(detail, "failed to unmarshal SDP") {
		t.Fatalf("parser reason stripped too aggressively: %q", detail)
	}
}

type errString string

func (e errString) Error() string { return string(e) }

// TestNegotiationFailureResponseContract ensures the public response body and
// status contract are unchanged by the diagnostic logging.
func TestNegotiationFailureResponseContract(t *testing.T) {
	code, _ := negotiationFailureLogsBody(t)
	if code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", code)
	}
}

func negotiationFailureLogsBody(t *testing.T) (int, map[string]string) {
	t.Helper()
	engine, err := gwrtc.NewEngine(gwrtc.Config{NegotiateTO: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		Secret:   secret,
		Engine:   engine,
		Registry: session.NewRegistry(5),
		Replay:   auth.NewReplayGuard(time.Minute),
		Logger:   slog.New(slog.NewTextHandler(discard{}, nil)),
	}
	mux := http.NewServeMux()
	s.Routes(mux)
	body := offerBody(t, "call-diag", sdpBadPort)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, signedReq(t, http.MethodPost, "/v1/calls/offer", mintToken(t, "call-diag", "ndiag", time.Minute), body))
	var resp map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp["error"] != "negotiation_failed" {
		t.Fatalf("response contract changed: %v", resp)
	}
	return rr.Code, resp
}
