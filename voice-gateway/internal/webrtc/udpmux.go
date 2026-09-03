package webrtc

import (
	"fmt"
	"net"

	"github.com/pion/ice/v4"
	pion "github.com/pion/webrtc/v4"
)

// NewUDPMux binds the single IPv4 media-plane UDP socket and wraps it in a Pion
// ICE UDP mux so every PeerConnection multiplexes over one fixed port.
//
// On Fly.io the socket MUST bind to the special "fly-global-services" address:
// binding 0.0.0.0 does not receive forwarded UDP. The function fails closed —
// it never falls back to a wildcard address.
func NewUDPMux(host string, port int) (ice.UDPMux, *net.UDPConn, error) {
	conn, err := listenUDP("udp4", host, port)
	if err != nil {
		return nil, nil, err
	}
	return pion.NewICEUDPMux(nil, conn), conn, nil
}

// NewDualStackUDPMux binds the IPv4 media socket and, when host6 is non-empty,
// an IPv6 media socket on the same port, returning a single multiplexed ICE mux.
//
// IPv4 is mandatory and fails closed. IPv6 is best-effort: an IPv6 bind failure
// is reported through v6Err and the gateway continues IPv4-only rather than
// dropping all media. Advertising an IPv6 host candidate requires BOTH a bound
// IPv6 socket here AND the IPv6 address present in PUBLIC_IP (NAT1To1) —
// SetNAT1To1IPs only rewrites candidates produced by existing local sockets.
//
// On Fly.io, forwarded IPv6 UDP arrives on the wildcard "::" address, not on
// fly-global-services (which resolves to IPv4 only).
func NewDualStackUDPMux(host string, host6 string, port int) (mux ice.UDPMux, conns []*net.UDPConn, v6Err error, err error) {
	conn4, err := listenUDP("udp4", host, port)
	if err != nil {
		return nil, nil, nil, err
	}
	conns = append(conns, conn4)
	muxes := []ice.UDPMux{pion.NewICEUDPMux(nil, conn4)}

	if host6 != "" {
		conn6, err6 := listenUDP("udp6", host6, port)
		if err6 != nil {
			v6Err = err6
		} else {
			conns = append(conns, conn6)
			muxes = append(muxes, pion.NewICEUDPMux(nil, conn6))
		}
	}

	if len(muxes) == 1 {
		return muxes[0], conns, v6Err
	}
	return ice.NewMultiUDPMuxDefault(muxes...), conns, v6Err
}

func listenUDP(network, host string, port int) (*net.UDPConn, error) {
	if host == "" {
		return nil, fmt.Errorf("udp mux: media host must be set")
	}
	if port <= 0 || port > 65535 {
		return nil, fmt.Errorf("udp mux: invalid media port %d", port)
	}
	addr, err := net.ResolveUDPAddr(network, net.JoinHostPort(host, fmt.Sprint(port)))
	if err != nil {
		return nil, fmt.Errorf("udp mux: resolve %s %s:%d: %w", network, host, port, err)
	}
	conn, err := net.ListenUDP(network, addr)
	if err != nil {
		return nil, fmt.Errorf("udp mux: bind %s %s:%d: %w", network, host, port, err)
	}
	return conn, nil
}

// IPFamilies reports how many IPv4 and IPv6 literals a NAT1To1 list contains.
// Non-sensitive: counts only, never the addresses themselves.
func IPFamilies(ips []string) (v4 int, v6 int) {
	for _, s := range ips {
		ip := net.ParseIP(s)
		if ip == nil {
			continue
		}
		if ip.To4() != nil {
			v4++
		} else {
			v6++
		}
	}
	return v4, v6
}
