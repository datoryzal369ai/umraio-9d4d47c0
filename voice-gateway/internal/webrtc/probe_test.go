package webrtc

import (
	"context"
	"testing"
	"time"

	"github.com/umraio/voice-gateway/internal/session"
)

func TestProbeSetRemoteFailure(t *testing.T) {
	candidates := map[string]string{
		"short_ufrag": "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:111 opus/48000/2\r\na=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\na=ice-ufrag:ab\r\na=ice-pwd:cd\r\na=setup:actpass\r\na=mid:0\r\n",
		"bad_fingerprint": "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:111 opus/48000/2\r\na=fingerprint:sha-256 ZZZZZZZZ\r\na=ice-ufrag:abcdef\r\na=ice-pwd:0123456789abcdef0123\r\na=setup:actpass\r\na=mid:0\r\n",
	}
	for name, sdp := range candidates {
		if err := ValidateOffer(sdp); err != nil {
			t.Logf("%s: failed ValidateOffer: %v", name, err)
			continue
		}
		eng, err := NewEngine(Config{NegotiateTO: 5 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		sess := session.New("ms_probe", "call-probe", "ag", "pn", time.Now())
		_, ms, err := eng.Establish(context.Background(), sess, sdp, nil, Hooks{})
		if err != nil {
			t.Logf("%s: Establish error: %q", name, err.Error())
		} else {
			t.Logf("%s: unexpectedly succeeded", name)
			ms.Terminate("probe")
		}
	}
}
