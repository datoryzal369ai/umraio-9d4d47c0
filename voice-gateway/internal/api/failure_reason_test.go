package api

import (
	"testing"

	"github.com/umraio/voice-gateway/internal/callback"
)

// Every failed or terminated session must reach the control plane with an
// explicit, enumerated reason — never an empty string.
func TestFailureReasonAlwaysExplicit(t *testing.T) {
	if got := failureReason(callback.EventMediaFailed, ""); got != "media_failed_unspecified" {
		t.Fatalf("media_failed default = %q", got)
	}
	if got := failureReason(callback.EventTerminated, ""); got != "terminated_unspecified" {
		t.Fatalf("terminated default = %q", got)
	}
	if got := failureReason(callback.EventMediaFailed, "negotiation_failed"); got != "negotiation_failed" {
		t.Fatalf("explicit reason must be preserved, got %q", got)
	}
	// Non-failure events stay reason-free.
	if got := failureReason(callback.EventMediaReady, ""); got != "" {
		t.Fatalf("media_ready reason = %q, want empty", got)
	}
}
