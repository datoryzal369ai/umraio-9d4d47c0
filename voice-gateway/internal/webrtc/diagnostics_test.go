package webrtc

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/umraio/voice-gateway/internal/session"
)

const answerFixture = "v=0\r\n" +
	"o=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
	"m=audio 40000 UDP/TLS/RTP/SAVPF 111\r\n" +
	"a=rtpmap:111 opus/48000/2\r\n" +
	"a=ice-ufrag:secretufrag\r\na=ice-pwd:secretpassword\r\n" +
	"a=fingerprint:sha-256 AA:BB\r\n" +
	"a=candidate:1 1 udp 2130706431 203.0.113.9 40000 typ host\r\n" +
	"a=candidate:2 1 udp 1694498815 198.51.100.4 40000 typ srflx\r\n" +
	"a=candidate:3 1 udp 16777215 192.0.2.7 3478 typ relay\r\n"

func TestSummarizeAnswerStructureOnly(t *testing.T) {
	s := SummarizeAnswer(answerFixture)
	if !s.Present || s.Length != len(answerFixture) {
		t.Fatalf("unexpected presence/length: %+v", s)
	}
	if s.CandidateCount != 3 || !s.HasHost || !s.HasSrflx || !s.HasRelay {
		t.Fatalf("unexpected candidate summary: %+v", s)
	}
	if !s.HasAudio || !s.HasOpus {
		t.Fatalf("expected audio/opus: %+v", s)
	}
	if e := SummarizeAnswer(""); e.Present || e.CandidateCount != 0 {
		t.Fatalf("empty answer must summarize empty: %+v", e)
	}
}

func TestAnswerSummaryLogAttrsLeakNothingSensitive(t *testing.T) {
	buf := &bytes.Buffer{}
	log := slog.New(slog.NewJSONHandler(buf, nil))
	log.Info("local answer generated", SummarizeAnswer(answerFixture).LogAttrs()...)
	out := buf.String()
	for _, forbidden := range []string{
		"203.0.113.9", "198.51.100.4", "192.0.2.7", "40000", "3478",
		"secretufrag", "secretpassword", "fingerprint", "a=candidate", "v=0", "sha-256",
	} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("diagnostic log leaked %q: %s", forbidden, out)
		}
	}
	var fields map[string]any
	if err := json.Unmarshal([]byte(out), &fields); err != nil {
		t.Fatalf("log not structured: %v", err)
	}
	for _, k := range []string{"answer_sdp_present", "answer_length", "candidate_count",
		"has_host_candidate", "has_srflx_candidate", "has_relay_candidate", "has_audio", "has_opus"} {
		if _, ok := fields[k]; !ok {
			t.Fatalf("missing diagnostic field %s", k)
		}
	}
}

// A real negotiation must emit lifecycle diagnostics without any SDP,
// candidate, or ICE credential material reaching the log sink.
func TestEngineDiagnosticsAreSafe(t *testing.T) {
	buf := &bytes.Buffer{}
	log := slog.New(slog.NewJSONHandler(buf, nil))
	e, err := NewEngine(Config{NegotiateTO: 5 * time.Second, Logger: log})
	if err != nil {
		t.Fatalf("engine: %v", err)
	}
	offerer, err := NewEngine(Config{NegotiateTO: 5 * time.Second, Logger: slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))})
	if err != nil {
		t.Fatalf("offerer engine: %v", err)
	}
	offer, cleanup, err := makeOffer(offerer)
	if err != nil {
		t.Fatalf("offer: %v", err)
	}
	defer cleanup()

	sess := session.New("sess-diag", "call-diag", "agency", "phone", time.Now())
	answer, ms, err := e.Establish(context.Background(), sess, offer, nil, Hooks{})
	if err != nil {
		t.Fatalf("establish: %v", err)
	}
	defer ms.Terminate("test_done")

	out := buf.String()
	if !strings.Contains(out, "ice gathering state") || !strings.Contains(out, "local answer generated") {
		t.Fatalf("expected gathering + answer diagnostics: %s", out)
	}
	if !strings.Contains(out, "udp_mux_configured") || !strings.Contains(out, "nat_1to1_configured") {
		t.Fatalf("expected posture diagnostics: %s", out)
	}
	if strings.Contains(out, "v=0") || strings.Contains(out, "a=candidate") ||
		strings.Contains(out, "ice-ufrag") || strings.Contains(out, "fingerprint") {
		t.Fatalf("diagnostics leaked sdp material: %s", out)
	}
	for _, line := range strings.Split(answer, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "a=candidate:") && strings.Contains(out, line) {
			t.Fatalf("diagnostics leaked candidate line")
		}
	}
}
