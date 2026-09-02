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

// realistic Meta-style offer WITHOUT a terminating newline (production defect).
const untermOffer = "v=0\r\n" +
	"o=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n" +
	"s=-\r\nt=0 0\r\n" +
	"a=group:BUNDLE 0\r\n" +
	"m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" +
	"c=IN IP4 0.0.0.0\r\n" +
	"a=rtcp-mux\r\n" +
	"a=ice-ufrag:abcd\r\na=ice-pwd:efghijklmnopqrstuvwx\r\n" +
	"a=fingerprint:sha-256 AA:BB:CC\r\n" +
	"a=setup:actpass\r\na=mid:0\r\na=sendrecv\r\n" +
	"a=rtpmap:111 opus/48000/2"

func TestNormalizeOfferTerminatorAppendsCRLF(t *testing.T) {
	got := NormalizeOfferTerminator(untermOffer)
	if got != untermOffer+"\r\n" {
		t.Fatal("expected exactly one CRLF appended")
	}
	if NormalizeOfferTerminator(got) != got {
		t.Fatal("normalization must be idempotent")
	}
}

func TestNormalizeOfferTerminatorLeavesTerminatedSDPUntouched(t *testing.T) {
	if NormalizeOfferTerminator(goodOffer) != goodOffer {
		t.Fatal("LF-terminated sdp must not be modified")
	}
	crlf := untermOffer + "\r\n"
	if NormalizeOfferTerminator(crlf) != crlf {
		t.Fatal("CRLF-terminated sdp must not be modified")
	}
	if NormalizeOfferTerminator("") != "" {
		t.Fatal("empty sdp must stay empty")
	}
}

func TestValidateOfferAcceptsRealisticMetaOffer(t *testing.T) {
	if err := ValidateOffer(untermOffer); err != nil {
		t.Fatalf("realistic meta offer rejected: %v", err)
	}
}
