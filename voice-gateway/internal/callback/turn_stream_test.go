package callback

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/umraio/voice-gateway/internal/auth"
	"github.com/umraio/voice-gateway/internal/media"
)

func TestCallingStreamAcknowledgementPrecedesFinalWithExistingHMAC(t *testing.T) {
	final := make(chan struct{})
	acknowledged := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != TurnPath || auth.VerifyRequest("synthetic-test-secret", r.Header.Get(auth.SignatureHeader), r.Header.Get(auth.TimestampHeader), body, time.Now()) != nil {
			t.Error("existing signed control contract changed")
			w.WriteHeader(401)
			return
		}
		if r.Header.Get("Accept") != "application/x-ndjson" {
			t.Error("stream not negotiated")
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		fmt.Fprintln(w, `{"type":"ack","speech_text":"Baik, sekejap ya.","voice_id":"Malay_male_1_v1","language_boost":"Malay","end_call":false}`)
		w.(http.Flusher).Flush()
		select {
		case <-final:
		case <-r.Context().Done():
			return
		}
		fmt.Fprintln(w, `{"type":"final","speech_text":"Jawapan sebenar.","voice_id":"Malay_male_1_v1","end_call":false}`)
	}))
	defer server.Close()
	c := NewTurnClient(server.URL, "synthetic-test-secret", time.Second)
	result := make(chan error, 1)
	go func() {
		response, err := c.TurnStream(context.Background(), media.TurnRequest{CallID: "synthetic", Kind: media.TurnKindUtterance}, func(ack media.TurnResponse) {
			if ack.SpeechText == "" || ack.VoiceID != "Malay_male_1_v1" {
				t.Error("ack identity lost")
			}
			close(acknowledged)
		})
		if err == nil && response.SpeechText != "Jawapan sebenar." {
			t.Error("final answer lost")
		}
		result <- err
	}()
	select {
	case <-acknowledged:
	case <-time.After(time.Second):
		t.Fatal("ack buffered until final")
	}
	close(final)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestCallingStreamAcceptsLegacyJSONServer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"speech_text":"legacy answer","end_call":false}`)
	}))
	defer server.Close()
	c := NewTurnClient(server.URL, "synthetic-test-secret", time.Second)
	response, err := c.TurnStream(context.Background(), media.TurnRequest{}, func(media.TurnResponse) { t.Error("legacy server emitted ack") })
	if err != nil || response.SpeechText != "legacy answer" {
		t.Fatal("legacy compatibility failed")
	}
}

func TestCallingStreamFailsClosedOnTruncationAndInvalidFrames(t *testing.T) {
	for _, body := range []string{
		`{"type":"ack","speech_text":"Baik","end_call":false}`,
		`{"type":"ack","speech_text":"Baik","end_call":true}`,
		`{"type":"error","reason":"reasoning_failed"}`,
		`not json`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/x-ndjson")
			fmt.Fprintln(w, body)
		}))
		c := NewTurnClient(server.URL, "synthetic-test-secret", time.Second)
		response, err := c.TurnStream(context.Background(), media.TurnRequest{}, func(media.TurnResponse) {})
		server.Close()
		if err == nil || response != nil {
			t.Fatal("invalid or incomplete stream accepted")
		}
	}
}
