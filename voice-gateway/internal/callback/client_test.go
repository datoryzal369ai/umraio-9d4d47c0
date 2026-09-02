package callback

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/umraio/voice-gateway/internal/auth"
)

const secret = "0123456789abcdef0123456789abcdef0123456789"

func TestSendSignsRequestAndControlPlaneCanVerify(t *testing.T) {
	var verified atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != CallbackEventPath {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if err := auth.VerifyRequest(secret, r.Header.Get(auth.SignatureHeader), r.Header.Get(auth.TimestampHeader), body, time.Now()); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var ev Event
		if err := json.Unmarshal(body, &ev); err != nil || ev.CallID == "" || ev.Nonce == "" || ev.Timestamp == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		// Control plane must not be able to trust an agency claim from here.
		if strings.Contains(string(body), "agency_id") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		verified.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, secret, 2*time.Second, 2, 10*time.Millisecond)
	if err := c.Send(context.Background(), Event{Event: EventMediaReady, CallID: "call-1", SessionID: "ms_1"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	if !verified.Load() {
		t.Fatal("control plane did not verify the callback")
	}
}

func TestSendRetriesThenFails(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := New(srv.URL, secret, time.Second, 3, 5*time.Millisecond)
	if err := c.Send(context.Background(), Event{Event: EventTerminated, CallID: "call-1"}); err == nil {
		t.Fatal("expected failure after retries")
	}
	if hits.Load() != 3 {
		t.Fatalf("expected 3 attempts, got %d", hits.Load())
	}
}

func TestSendRejectsForgedSecret(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if err := auth.VerifyRequest(secret, r.Header.Get(auth.SignatureHeader), r.Header.Get(auth.TimestampHeader), body, time.Now()); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, "wrong-secret-wrong-secret-wrong-secret", time.Second, 1, time.Millisecond)
	if err := c.Send(context.Background(), Event{Event: EventMediaReady, CallID: "call-1"}); err == nil {
		t.Fatal("control plane must reject a callback signed with the wrong secret")
	}
}

func TestSendReturnsTypedHTTPStatusWithoutBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"secret":"super-sensitive","sdp":"v=0"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, secret, time.Second, 1, time.Millisecond)
	err := c.Send(context.Background(), Event{Event: EventNegotiating, CallID: "call-1", SessionID: "ms_1"})
	if err == nil {
		t.Fatal("expected error")
	}
	if got := StatusOf(err); got != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", got)
	}
	if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "sdp") {
		t.Fatalf("error leaked response body: %s", err.Error())
	}
}

func TestStatusOfTransportErrorIsZero(t *testing.T) {
	c := New("http://127.0.0.1:1", secret, 200*time.Millisecond, 1, time.Millisecond)
	err := c.Send(context.Background(), Event{Event: EventMediaReady, CallID: "call-1"})
	if err == nil {
		t.Fatal("expected transport error")
	}
	if StatusOf(err) != 0 {
		t.Fatalf("expected 0 for transport error, got %d", StatusOf(err))
	}
}
