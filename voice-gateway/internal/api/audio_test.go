package api

// Converter endpoint contract: authentication, input validation, bounded input,
// and a decodable OGG/Opus body. The audio-level checks (tone, duration, tail)
// live in internal/tts and internal/media.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/umraio/voice-gateway/internal/auth"
	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/tts"
)

// tonePCM returns s16le / 24 kHz / mono speech-like audio.
func tonePCM(seconds float64) []byte {
	n := int(float64(tts.SampleRateHz) * seconds)
	out := make([]byte, n*2)
	for i := 0; i < n; i++ {
		v := int16(12000 * math.Sin(2*math.Pi*220*float64(i)/float64(tts.SampleRateHz)))
		binary.LittleEndian.PutUint16(out[i*2:], uint16(v))
	}
	return out
}

func convertRequest(t *testing.T, mux *http.ServeMux, body []byte, sign bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/v1/audio/opus", bytes.NewReader(body))
	if sign {
		ts := fixedNow()
		req.Header.Set(auth.TimestampHeader, strconv.FormatInt(ts.Unix(), 10))
		req.Header.Set(auth.SignatureHeader, auth.SignRequest(secret, ts.Unix(), body))
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func envelope(t *testing.T, pcm []byte) []byte {
	t.Helper()
	b, err := json.Marshal(audioOpusRequest{PCMBase64: base64.StdEncoding.EncodeToString(pcm)})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAudioOpusRequiresSignature(t *testing.T) {
	_, _, mux := newServer(t, 4)
	if rec := convertRequest(t, mux, envelope(t, tonePCM(0.2)), false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned request accepted: %d", rec.Code)
	}
	// Tampered body must not verify either.
	body := envelope(t, tonePCM(0.2))
	req := httptest.NewRequest("POST", "/v1/audio/opus", bytes.NewReader(append(body[:len(body)-1], []byte("X\"}")...)))
	ts := fixedNow()
	req.Header.Set(auth.TimestampHeader, strconv.FormatInt(ts.Unix(), 10))
	req.Header.Set(auth.SignatureHeader, auth.SignRequest(secret, ts.Unix(), body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("tampered body accepted: %d", rec.Code)
	}
}

func TestAudioOpusRejectsMalformedInput(t *testing.T) {
	_, _, mux := newServer(t, 4)
	cases := map[string][]byte{
		"empty_pcm":     envelope(t, nil),
		"odd_bytes":     envelope(t, []byte{1, 2, 3}),
		"one_byte":      envelope(t, []byte{1}),
		"bad_base64":    []byte(`{"pcm_base64":"!!!not base64!!!"}`),
		"not_json":      []byte("nope"),
		"wrong_type":    []byte(`{"pcm_base64":123}`),
		"missing_field": []byte(`{}`),
	}
	for name, body := range cases {
		rec := convertRequest(t, mux, body, true)
		if rec.Code < 400 || rec.Code >= 500 {
			t.Fatalf("%s: expected 4xx, got %d", name, rec.Code)
		}
	}
}

func TestAudioOpusRejectsOversizedPCM(t *testing.T) {
	_, _, mux := newServer(t, 4)
	rec := convertRequest(t, mux, envelope(t, make([]byte, tts.MaxFilePCMBytes+2)), true)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized pcm accepted: %d", rec.Code)
	}
}

func TestAudioOpusProducesDecodableOgg(t *testing.T) {
	if !tts.FileEncoderAvailable() {
		t.Skip("no cgo encoder in this build")
	}
	_, _, mux := newServer(t, 4)
	rec := convertRequest(t, mux, envelope(t, tonePCM(0.5)), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("convert failed: %d %s", rec.Code, rec.Body.String())
	}
	var resp audioOpusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Encoder != "native_libopus" || resp.DurationMs != 500 {
		t.Fatalf("unexpected metadata: %+v", resp)
	}
	ogg, err := base64.StdEncoding.DecodeString(resp.OggBase64)
	if err != nil {
		t.Fatal(err)
	}
	if len(ogg) != resp.Bytes || string(ogg[0:4]) != "OggS" {
		t.Fatalf("not an ogg stream (%d bytes)", len(ogg))
	}
	packets, err := umedia.ReadOggOpus(ogg)
	if err != nil {
		t.Fatalf("ogg unreadable: %v", err)
	}
	if len(packets) < 25 {
		t.Fatalf("expected >=25 audio packets, got %d", len(packets))
	}
}

func TestAudioOpusFailsClosedWithoutEncoder(t *testing.T) {
	if tts.FileEncoderAvailable() {
		t.Skip("cgo build: unavailable path is covered by the !cgo build")
	}
	_, _, mux := newServer(t, 4)
	if rec := convertRequest(t, mux, envelope(t, tonePCM(0.2)), true); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 fail-closed, got %d", rec.Code)
	}
}
