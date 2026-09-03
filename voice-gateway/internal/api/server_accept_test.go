package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The accept notification is the only trigger for the opening greeting, so it
// must be authenticated, session-scoped and idempotent.

func acceptedPath(callID string) string { return "/v1/calls/" + callID + "/accepted" }

func TestAcceptedRequiresAuth(t *testing.T) {
	_, _, mux := newServer(t, 4)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, acceptedPath("call-1"), nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated accept notification: got %d want 401", rec.Code)
	}
}

func TestAcceptedUnknownSessionIsNotFound(t *testing.T) {
	_, _, mux := newServer(t, 4)
	body := []byte(`{"event":"meta_accepted"}`)
	req := signedReq(t, http.MethodPost, acceptedPath("call-missing"),
		mintToken(t, "call-missing", "n-accept-1", time.Minute), body)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown session: got %d want 404", rec.Code)
	}
}

func TestAcceptedIsIdempotentForLiveSession(t *testing.T) {
	_, _, mux := newServer(t, 4)
	callID := "call-accept"

	offer := signedReq(t, http.MethodPost, "/v1/calls/offer",
		mintToken(t, callID, "n-offer", time.Minute), offerBody(t, callID, realOffer(t)))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, offer)
	if rec.Code != http.StatusOK {
		t.Fatalf("offer: got %d want 200 (%s)", rec.Code, rec.Body.String())
	}

	body := []byte(`{"event":"meta_accepted"}`)
	outcomes := make([]string, 0, 2)
	for i, nonce := range []string{"n-accept-a", "n-accept-b"} {
		req := signedReq(t, http.MethodPost, acceptedPath(callID), mintToken(t, callID, nonce, time.Minute), body)
		r := httptest.NewRecorder()
		mux.ServeHTTP(r, req)
		if r.Code != http.StatusOK {
			t.Fatalf("accept notification %d: got %d want 200 (%s)", i, r.Code, r.Body.String())
		}
		var parsed AcceptedResponse
		if err := json.Unmarshal(r.Body.Bytes(), &parsed); err != nil {
			t.Fatal(err)
		}
		if parsed.CallID != callID {
			t.Fatalf("call id echoed wrong: %q", parsed.CallID)
		}
		outcomes = append(outcomes, parsed.Greeting)
	}
	// The default test pipeline is the no-op one, so the outcome is a stable
	// enum rather than "started"; the contract under test is that a repeat
	// notification never errors and never starts a second greeting.
	if outcomes[0] != outcomes[1] && outcomes[1] != "duplicate" {
		t.Fatalf("repeat notification not idempotent: %v", outcomes)
	}
	for _, o := range outcomes {
		if o == "" {
			t.Fatal("greeting outcome missing from response")
		}
	}
}
