package webrtc

import (
	"errors"
	"strings"
	"testing"
)

const goodOffer = `v=0
o=- 1 2 IN IP4 127.0.0.1
s=-
t=0 0
a=fingerprint:sha-256 AA:BB:CC
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtpmap:111 opus/48000/2
a=ice-ufrag:abcd
a=ice-pwd:efghijklmnopqrstuvwx
a=sendrecv
`

func TestValidateOfferAcceptsOpusOffer(t *testing.T) {
	if err := ValidateOffer(goodOffer); err != nil {
		t.Fatalf("expected valid offer: %v", err)
	}
}

func TestValidateOfferRejectsEmpty(t *testing.T) {
	if err := ValidateOffer(""); !errors.Is(err, ErrSDPEmpty) {
		t.Fatalf("expected ErrSDPEmpty, got %v", err)
	}
}

func TestValidateOfferRejectsOversized(t *testing.T) {
	if err := ValidateOffer(goodOffer + strings.Repeat("a=x\n", MaxSDPBytes)); !errors.Is(err, ErrSDPTooLarge) {
		t.Fatalf("expected ErrSDPTooLarge, got %v", err)
	}
}

func TestValidateOfferRejectsNonOpus(t *testing.T) {
	pcmu := strings.Replace(goodOffer, "a=rtpmap:111 opus/48000/2", "a=rtpmap:0 PCMU/8000", 1)
	if err := ValidateOffer(pcmu); !errors.Is(err, ErrSDPNoOpus) {
		t.Fatalf("expected ErrSDPNoOpus, got %v", err)
	}
}

func TestValidateOfferRejectsMissingDTLSOrICE(t *testing.T) {
	noFp := strings.Replace(goodOffer, "a=fingerprint:sha-256 AA:BB:CC\n", "", 1)
	if err := ValidateOffer(noFp); !errors.Is(err, ErrSDPNoDTLS) {
		t.Fatalf("expected ErrSDPNoDTLS, got %v", err)
	}
	noIce := strings.Replace(goodOffer, "a=ice-ufrag:abcd\n", "", 1)
	if err := ValidateOffer(noIce); !errors.Is(err, ErrSDPNoICE) {
		t.Fatalf("expected ErrSDPNoICE, got %v", err)
	}
}

func TestValidateOfferRejectsInsecureProfile(t *testing.T) {
	plain := strings.Replace(goodOffer, "UDP/TLS/RTP/SAVPF", "RTP/AVP", 1)
	if err := ValidateOffer(plain); !errors.Is(err, ErrSDPNotSecured) {
		t.Fatalf("expected ErrSDPNotSecured, got %v", err)
	}
}

func TestValidateOfferRejectsNonSDPGarbage(t *testing.T) {
	if err := ValidateOffer("{\"not\":\"sdp\"}"); !errors.Is(err, ErrSDPStructure) {
		t.Fatalf("expected ErrSDPStructure, got %v", err)
	}
}
