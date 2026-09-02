package webrtc

import (
	"strings"
	"testing"

	pion "github.com/pion/webrtc/v4"
)

// Proves the production failure ("failed to unmarshal SDP: EOF") is caused by a
// missing final newline and is cured by NormalizeOfferTerminator.
func TestSetRemoteDescriptionEOFWithoutTerminator(t *testing.T) {
	pc, err := pion.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	err = pc.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeOffer, SDP: untermOffer})
	if err == nil || !strings.Contains(err.Error(), "EOF") {
		t.Fatalf("expected EOF unmarshal failure, got %v", err)
	}
}

func TestSetRemoteDescriptionAcceptsNormalizedOffer(t *testing.T) {
	pc, err := pion.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	if err := pc.SetRemoteDescription(pion.SessionDescription{
		Type: pion.SDPTypeOffer, SDP: NormalizeOfferTerminator(untermOffer),
	}); err != nil {
		t.Fatalf("normalized offer rejected: %v", err)
	}
	if _, err := pc.CreateAnswer(nil); err != nil {
		t.Fatalf("answer generation failed: %v", err)
	}
}
