package api

// CONCURRENCY OWNERSHIP: the conversion slot must be owned by the encoder
// goroutine. If the handler released it on its own timeout, a slow encode plus
// new requests would run unbounded and starve the live-call media loop.

import (
	"net/http"
	"testing"
	"time"
)

func TestAudioOpusBusyWhenSlotsExhausted(t *testing.T) {
	_, _, mux := newServer(t, 4)
	for i := 0; i < maxConcurrentConversions; i++ {
		conversionSlots <- struct{}{}
	}
	defer func() {
		for i := 0; i < maxConcurrentConversions; i++ {
			<-conversionSlots
		}
	}()

	prev := AudioQueueTimeout
	AudioQueueTimeout = 60 * time.Millisecond
	defer func() { AudioQueueTimeout = prev }()

	start := time.Now()
	rec := convertRequest(t, mux, envelope(t, tonePCM(0.2)), true)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 encoder_busy, got %d %s", rec.Code, rec.Body.String())
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("busy response took %s: queue wait is not bounded", elapsed)
	}
	if len(conversionSlots) != maxConcurrentConversions {
		t.Fatalf("slot count changed to %d", len(conversionSlots))
	}
}

func TestAudioOpusSlotHeldUntilEncodeCompletes(t *testing.T) {
	if !encoderAvailableForTest() {
		t.Skip("no cgo encoder in this build")
	}
	_, _, mux := newServer(t, 4)

	prev := AudioConvertTimeout
	// Force the handler to give up while the encode is still running.
	AudioConvertTimeout = time.Nanosecond
	rec := convertRequest(t, mux, envelope(t, tonePCM(2)), true)
	AudioConvertTimeout = prev
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected 504 encode_timeout, got %d %s", rec.Code, rec.Body.String())
	}
	// The slot is still held by the running encoder, not by the handler.
	if len(conversionSlots) != 1 {
		t.Fatalf("slot released early: %d in flight", len(conversionSlots))
	}
	deadline := time.Now().Add(20 * time.Second)
	for len(conversionSlots) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("slot never released after encode finished")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
