package tts

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func lookupFrom(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestLoadConfigRequiresKeyAndLocksVoice(t *testing.T) {
	if _, ok := LoadConfig(lookupFrom(map[string]string{})); ok {
		t.Fatal("expected TTS to stay disabled without a key")
	}
	cfg, ok := LoadConfig(lookupFrom(map[string]string{"MINIMAX_TTS_API_KEY": "k"}))
	if !ok {
		t.Fatal("expected configured")
	}
	if cfg.Model != "speech-2.8-hd" || cfg.VoiceID != "Malay_male_1_v1" || cfg.Boost != "Malay" {
		t.Fatalf("voice lock broken: %+v", cfg)
	}
}

func TestSynthesizeSendsLockedIdentityAndNeverLeaksKey(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		pcm := make([]byte, 24000*2/10) // 100 ms
		resp, _ := json.Marshal(map[string]any{"data": map[string]any{"audio": hex.EncodeToString(pcm)}})
		w.Write(resp)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, APIKey: "secret-key"})
	pcm, err := c.SynthesizePCM(context.Background(), "Assalamualaikum", "", "")
	if err != nil {
		t.Fatalf("synthesize: %v", err)
	}
	if len(pcm) != 4800 {
		t.Fatalf("pcm length %d", len(pcm))
	}
	if got["model"] != "speech-2.8-hd" || got["language_boost"] != "Malay" {
		t.Fatalf("identity not locked: %v", got)
	}
	vs := got["voice_setting"].(map[string]any)
	if vs["voice_id"] != "Malay_male_1_v1" {
		t.Fatalf("voice not locked: %v", vs)
	}
	as := got["audio_setting"].(map[string]any)
	if as["format"] != "pcm" || as["sample_rate"].(float64) != 24000 || as["channel"].(float64) != 1 {
		t.Fatalf("pcm shape wrong: %v", as)
	}
	if !strings.HasPrefix(auth, "Bearer ") {
		t.Fatal("missing bearer")
	}
}

func TestProviderErrorIsSanitized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"secret":"leak"}`))
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, APIKey: "secret-key"})
	_, err := c.SynthesizePCM(context.Background(), "hi", "", "")
	if !errors.Is(err, ErrProvider) {
		t.Fatalf("want provider error, got %v", err)
	}
	if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "leak") {
		t.Fatalf("error leaked payload: %v", err)
	}
}

func TestEncodeOpusProducesPacedFrames(t *testing.T) {
	if !EncoderAvailable() {
		t.Skip("built without cgo")
	}
	// 1 s of 440 Hz tone, s16le 24 kHz mono.
	pcm := make([]byte, 24000*2)
	for i := 0; i < 24000; i++ {
		v := int16(8000 * math.Sin(2*math.Pi*440*float64(i)/24000))
		pcm[i*2] = byte(v)
		pcm[i*2+1] = byte(v >> 8)
	}
	packets, err := EncodeOpus(pcm)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(packets) != 50 {
		t.Fatalf("expected 50 x 20ms packets, got %d", len(packets))
	}
	for i, p := range packets {
		if len(p) == 0 {
			t.Fatalf("empty packet at %d", i)
		}
	}
}

func TestEmptyTextIsRejectedWithoutRequest(t *testing.T) {
	c := NewClient(Config{BaseURL: "http://127.0.0.1:1", APIKey: "k"})
	if _, err := c.SynthesizePCM(context.Background(), "   ", "", ""); !errors.Is(err, ErrEmptyAudio) {
		t.Fatalf("want empty audio error, got %v", err)
	}
}

// A non-canonical voice must fail closed instead of speaking with another voice.
func TestSynthesizeRejectsNonCanonicalVoice(t *testing.T) {
	c := NewClient(Config{APIKey: "k"})
	if _, err := c.SynthesizePCM(context.Background(), "Salam", "Indonesian_male_1", "Malay"); !errors.Is(err, ErrVoiceIdentity) {
		t.Fatalf("expected voice identity rejection, got %v", err)
	}
}
