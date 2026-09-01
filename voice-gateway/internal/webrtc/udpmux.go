package webrtc

import (
	"fmt"
	"net"

	"github.com/pion/ice/v4"
	pion "github.com/pion/webrtc/v4"
)

// NewUDPMux binds the single media-plane UDP socket and wraps it in a Pion ICE
// UDP mux so every PeerConnection multiplexes over one fixed port.
//
// On Fly.io the socket MUST bind to the special "fly-global-services" address:
// binding 0.0.0.0 does not receive forwarded UDP. The function fails closed —
// it never falls back to a wildcard address.
func NewUDPMux(host string, port int) (ice.UDPMux, *net.UDPConn, error) {
	if host == "" {
		return nil, nil, fmt.Errorf("udp mux: media host must be set")
	}
	if port <= 0 || port > 65535 {
		return nil, nil, fmt.Errorf("udp mux: invalid media port %d", port)
	}

	addr, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(host, fmt.Sprint(port)))
	if err != nil {
		return nil, nil, fmt.Errorf("udp mux: resolve %s:%d: %w", host, port, err)
	}
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		return nil, nil, fmt.Errorf("udp mux: bind %s:%d: %w", host, port, err)
	}
	return pion.NewICEUDPMux(nil, conn), conn, nil
}
