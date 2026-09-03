package webrtc

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/umraio/voice-gateway/internal/session"
)

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

func TestIPFamiliesSplitsNAT1To1List(t *testing.T) {
	v4, v6 := IPFamilies([]string{"149.248.202.126", "2a09:8280:1::180:ea3c:0", "not-an-ip"})
	if v4 != 1 || v6 != 1 {
		t.Fatalf("expected 1 ipv4 and 1 ipv6, got v4=%d v6=%d", v4, v6)
	}
}

func TestDualStackMuxBindsBothFamilies(t *testing.T) {
	port := freeUDPPort(t)
	mux, conns, v6Err, err := NewDualStackUDPMux("0.0.0.0", "::", port)
	if err != nil {
		t.Fatalf("ipv4 media bind must succeed: %v", err)
	}
	defer func() {
		_ = mux.Close()
		for _, c := range conns {
			_ = c.Close()
		}
	}()
	if v6Err != nil {
		t.Skipf("host has no usable IPv6 UDP stack: %v", v6Err)
	}
	if len(conns) != 2 {
		t.Fatalf("expected dual-stack sockets, got %d", len(conns))
	}
}

// The production invariant: an IPv6 host candidate appears in the generated
// answer ONLY when an IPv6 socket is bound AND the IPv6 address is present in
// PUBLIC_IP (NAT1To1). PUBLIC_IP alone is not sufficient.
func TestAnswerAdvertisesBothCandidateFamilies(t *testing.T) {
	port := freeUDPPort(t)
	mux, conns, v6Err, err := NewDualStackUDPMux("0.0.0.0", "::", port)
	if err != nil {
		t.Fatalf("ipv4 media bind must succeed: %v", err)
	}
	defer func() {
		_ = mux.Close()
		for _, c := range conns {
			_ = c.Close()
		}
	}()
	if v6Err != nil {
		t.Skipf("host has no usable IPv6 UDP stack: %v", v6Err)
	}

	engine, err := NewEngine(Config{
		UDPMux:      mux,
		NAT1To1IPs:  []string{"149.248.202.126", "2a09:8280:1::180:ea3c:0"},
		NegotiateTO: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	caller, _ := newLoopbackCaller(t)
	defer caller.Close()
	offer := callerOffer(t, caller)

	sess := session.New("ms_ds", "call-ds", "ag_1", "pn_1", time.Now())
	answer, ms, err := engine.Establish(context.Background(), sess, offer, nil, Hooks{})
	if err != nil {
		t.Fatalf("establish: %v", err)
	}
	defer ms.Terminate("test_done")

	v4, v6 := CandidateFamilies(answer)
	if v4 == 0 {
		t.Fatalf("answer advertised no IPv4 candidate")
	}
	if v6 == 0 {
		t.Fatalf("answer advertised no IPv6 candidate (dual-stack mux + NAT1To1 v6 required)")
	}
}
