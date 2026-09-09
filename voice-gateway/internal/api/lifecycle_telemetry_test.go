package api

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/umraio/voice-gateway/internal/callback"
	"github.com/umraio/voice-gateway/internal/session"
)

func TestTerminalCallbackEventMapping(t *testing.T) {
	tests := []struct {
		name  string
		state session.State
		want  string
	}{
		{name: "failed", state: session.StateFailed, want: callback.EventMediaFailed},
		{name: "terminated", state: session.StateTerminated, want: callback.EventTerminated},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := terminalCallbackEvent(tt.state); got != tt.want {
				t.Fatalf("terminalCallbackEvent(%s) = %q, want %q", tt.state, got, tt.want)
			}
		})
	}
}

type lifecycleTelemetryEmitter struct {
	err    error
	events chan callback.Event
}

func TestCallbackCarriesMeasuredPacketTimes(t *testing.T) {
	emitter := &lifecycleTelemetryEmitter{events: make(chan callback.Event, 1)}
	srv := &Server{Events: emitter, Logger: slog.Default(), Now: time.Now}
	sess := session.New("ms_times", "call_times", "agency", "phone", time.Now())
	inbound := time.Now().Add(-time.Second)
	sess.RecordInbound(inbound)
	sess.RecordOutbound()
	outbound := sess.Stats().FirstOutboundAt
	srv.emit(callback.EventTerminated, sess, "completed")
	select {
	case ev := <-emitter.events:
		if ev.FirstInboundAt != inbound.UTC().Format(time.RFC3339Nano) || ev.FirstOutboundAt != outbound.UTC().Format(time.RFC3339Nano) {
			t.Fatal("callback substituted emission time for packet time")
		}
		if ev.MediaReadyAt != "" {
			t.Fatal("callback invented readiness")
		}
	case <-time.After(time.Second):
		t.Fatal("callback missing")
	}
}

func (e *lifecycleTelemetryEmitter) Send(_ context.Context, ev callback.Event) error {
	e.events <- ev
	return e.err
}

type lifecycleTelemetryLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lifecycleTelemetryLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lifecycleTelemetryLog) entries() []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	var entries []map[string]any
	dec := json.NewDecoder(bytes.NewReader(l.buf.Bytes()))
	for {
		var entry map[string]any
		if err := dec.Decode(&entry); err != nil {
			break
		}
		entries = append(entries, entry)
	}
	return entries
}

func (l *lifecycleTelemetryLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func awaitCallbackDelivery(t *testing.T, logs *lifecycleTelemetryLog, outcome string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, entry := range logs.entries() {
			if entry["msg"] == "callback delivery" && entry["outcome"] == outcome {
				return entry
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for callback delivery outcome=%s; logs=%s", outcome, logs.String())
	return nil
}

func TestCallbackDeliveryTelemetrySuccessIsStructuredAndSafe(t *testing.T) {
	logs := &lifecycleTelemetryLog{}
	emitter := &lifecycleTelemetryEmitter{events: make(chan callback.Event, 1)}
	srv := &Server{
		Events: emitter,
		Logger: slog.New(slog.NewJSONHandler(logs, nil)),
		Now:    func() time.Time { return time.Unix(1_700_000_000, 0) },
	}
	sess := session.New(
		"ms_callback_success",
		"call_callback_success",
		"agency-sensitive-marker",
		"phone-sensitive-marker",
		time.Now(),
	)

	srv.emit(callback.EventMediaReady, sess, "")
	select {
	case ev := <-emitter.events:
		if ev.Event != callback.EventMediaReady || ev.CallID != sess.CallID || ev.SessionID != sess.ID {
			t.Fatalf("unexpected callback event: %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("callback emitter was not called")
	}
	entry := awaitCallbackDelivery(t, logs, "delivered")
	assertCallbackTelemetryFields(t, entry, callback.EventMediaReady, sess, 0)
	if _, ok := entry["error_class"]; ok {
		t.Fatalf("successful delivery should not report error_class: %+v", entry)
	}
	assertCallbackTelemetrySafe(t, logs.String())
}

func TestCallbackDeliveryTelemetryFailureIsStructuredAndSafe(t *testing.T) {
	logs := &lifecycleTelemetryLog{}
	emitter := &lifecycleTelemetryEmitter{
		err:    &callback.HTTPError{StatusCode: 503},
		events: make(chan callback.Event, 1),
	}
	srv := &Server{
		Events: emitter,
		Logger: slog.New(slog.NewJSONHandler(logs, nil)),
		Now:    time.Now,
	}
	sess := session.New(
		"ms_callback_failure",
		"call_callback_failure",
		"agency-sensitive-marker",
		"phone-sensitive-marker",
		time.Now(),
	)

	srv.emit(callback.EventMediaFailed, sess, "ice_failed")
	select {
	case <-emitter.events:
	case <-time.After(time.Second):
		t.Fatal("callback emitter was not called")
	}
	entry := awaitCallbackDelivery(t, logs, "failed")
	assertCallbackTelemetryFields(t, entry, callback.EventMediaFailed, sess, 503)
	if entry["error_class"] != "callback" {
		t.Fatalf("error_class = %v, want callback", entry["error_class"])
	}
	assertCallbackTelemetrySafe(t, logs.String())
}

func assertCallbackTelemetryFields(
	t *testing.T,
	entry map[string]any,
	event string,
	sess *session.Session,
	httpStatus float64,
) {
	t.Helper()
	if entry["event"] != event {
		t.Fatalf("event = %v, want %s", entry["event"], event)
	}
	if entry["call_id"] != sess.CallID || entry["session_id"] != sess.ID {
		t.Fatalf("callback identity fields missing: %+v", entry)
	}
	if entry["http_status"] != httpStatus {
		t.Fatalf("http_status = %v, want %.0f", entry["http_status"], httpStatus)
	}
	duration, ok := entry["duration_ms"].(float64)
	if !ok || duration < 0 {
		t.Fatalf("duration_ms is not a non-negative number: %+v", entry)
	}
}

func assertCallbackTelemetrySafe(t *testing.T, output string) {
	t.Helper()
	for _, forbidden := range []string{
		"agency-sensitive-marker",
		"phone-sensitive-marker",
		"nonce",
		"payload",
		"response_body",
		"sdp",
		"credential",
	} {
		if bytes.Contains([]byte(output), []byte(forbidden)) {
			t.Fatalf("callback telemetry leaked forbidden marker %q: %s", forbidden, output)
		}
	}
}

var _ Emitter = (*lifecycleTelemetryEmitter)(nil)
