package webrtc

import (
	"testing"

	pion "github.com/pion/webrtc/v4"
)

// A transient ICE blip must NOT end an otherwise healthy WhatsApp call.
func TestDisconnectedIsRecoverable(t *testing.T) {
	if IsTerminalPeerState(pion.PeerConnectionStateDisconnected) {
		t.Fatal("disconnected must be treated as recoverable, not terminal")
	}
}

func TestFailedAndClosedAreTerminal(t *testing.T) {
	for _, st := range []pion.PeerConnectionState{
		pion.PeerConnectionStateFailed,
		pion.PeerConnectionStateClosed,
	} {
		if !IsTerminalPeerState(st) {
			t.Fatalf("state %s must be terminal", st)
		}
	}
	if got := terminalPeerReason(pion.PeerConnectionStateFailed); got != "ice_failed" {
		t.Fatalf("failed reason = %q, want ice_failed", got)
	}
	if got := terminalPeerReason(pion.PeerConnectionStateClosed); got != "peer_closed" {
		t.Fatalf("closed reason = %q, want peer_closed", got)
	}
}

func TestConnectedAndConnectingAreNotTerminal(t *testing.T) {
	for _, st := range []pion.PeerConnectionState{
		pion.PeerConnectionStateNew,
		pion.PeerConnectionStateConnecting,
		pion.PeerConnectionStateConnected,
	} {
		if IsTerminalPeerState(st) {
			t.Fatalf("state %s must not be terminal", st)
		}
	}
}
