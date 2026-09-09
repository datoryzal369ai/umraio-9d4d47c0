package api

// VOICE-NOTE CONVERTER — POST /v1/audio/opus
//
// WHY: the published Worker runtime forbids compiling WebAssembly from bytes,
// so the in-Worker libopus encoder can never run in production. This gateway
// already links NATIVE libopus, so the control plane sends the validated
// MiniMax PCM here and receives a complete OGG/Opus voice-note file.
//
// SECURITY / LIMITS
//   - Same request HMAC + timestamp as every other control-plane hop. There is
//     NO call-scoped bearer token here (there is no call), and no unauthenticated
//     conversion path exists.
//   - Body, duration and concurrency are bounded independently of the call
//     routes, whose limits are unchanged.
//   - No provider call, and no PCM, body, signature or secret is ever logged.

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/umraio/voice-gateway/internal/auth"
	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/tts"
)

// MaxAudioBodyBytes bounds the JSON envelope: ~120 s of 24 kHz mono s16le PCM
// carried as base64, plus a small margin for the JSON wrapper.
const MaxAudioBodyBytes = 8 * 1024 * 1024

// AudioConvertTimeout bounds a single conversion, and AudioQueueTimeout bounds
// the wait for a free slot. Their sum stays inside the client's 30 s budget.
const AudioConvertTimeout = 20 * time.Second
const AudioQueueTimeout = 8 * time.Second


// maxConcurrentConversions keeps CPU-heavy complexity-10 encodes from starving
// the live-call media loop.
const maxConcurrentConversions = 2

var conversionSlots = make(chan struct{}, maxConcurrentConversions)

type audioOpusRequest struct {
	PCMBase64 string `json:"pcm_base64"`
}

type audioOpusResponse struct {
	OggBase64  string `json:"ogg_base64"`
	Bytes      int    `json:"bytes"`
	DurationMs int    `json:"duration_ms"`
	Encoder    string `json:"encoder"`
}

func (s *Server) handleAudioOpus(w http.ResponseWriter, r *http.Request) {
	s.init()

	body, err := io.ReadAll(io.LimitReader(r.Body, MaxAudioBodyBytes+1))
	if err != nil || len(body) > MaxAudioBodyBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "body_too_large")
		return
	}
	// Request-level HMAC only: this endpoint is call-agnostic.
	if err := auth.VerifyRequest(
		s.Secret,
		r.Header.Get(auth.SignatureHeader),
		r.Header.Get(auth.TimestampHeader),
		body,
		s.Now(),
	); err != nil {
		s.Logger.Warn("audio convert rejected", "error_class", errClass(err))
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req audioOpusRequest
	if err := json.Unmarshal(body, &req); err != nil || req.PCMBase64 == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request")
		return
	}
	pcm, err := base64.StdEncoding.DecodeString(req.PCMBase64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_base64")
		return
	}
	if len(pcm) < 2 || len(pcm)%2 != 0 {
		writeErr(w, http.StatusBadRequest, "invalid_pcm")
		return
	}
	if len(pcm) > tts.MaxFilePCMBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "pcm_too_large")
		return
	}
	if !tts.FileEncoderAvailable() {
		writeErr(w, http.StatusServiceUnavailable, "encoder_unavailable")
		return
	}

	// Slot ownership belongs to the ENCODER goroutine, not the handler: if the
	// client times out first, the slot must stay held until the encode really
	// finishes, otherwise maxConcurrentConversions stops bounding CPU.
	select {
	case conversionSlots <- struct{}{}:
	case <-time.After(AudioQueueTimeout):
		writeErr(w, http.StatusServiceUnavailable, "encoder_busy")
		return
	case <-r.Context().Done():
		writeErr(w, http.StatusServiceUnavailable, "client_gone")
		return
	}

	type result struct {
		file *tts.OpusFile
		err  error
	}
	done := make(chan result, 1)
	go func() {
		defer func() { <-conversionSlots }()
		file, encErr := tts.EncodeOpusFile(pcm)
		done <- result{file, encErr}
	}()

	var out result
	select {
	case out = <-done:
	case <-time.After(AudioConvertTimeout):
		writeErr(w, http.StatusGatewayTimeout, "encode_timeout")
		return
	case <-r.Context().Done():
		writeErr(w, http.StatusServiceUnavailable, "client_gone")
		return
	}
	if out.err != nil || out.file == nil || len(out.file.Packets) == 0 {
		s.Logger.Warn("audio convert failed", "error_class", errClass(out.err), "pcm_bytes", len(pcm))
		writeErr(w, http.StatusUnprocessableEntity, "encode_failed")
		return
	}


	ogg := umedia.WriteOggOpusFile(
		out.file.Packets,
		1,
		out.file.FrameSamples48,
		out.file.PreSkip,
		out.file.FinalGranule,
		tts.SampleRateHz,
	)
	durationMs := len(pcm) / 2 * 1000 / tts.SampleRateHz

	s.Logger.Info("audio converted", "pcm_bytes", len(pcm), "ogg_bytes", len(ogg), "duration_ms", durationMs)
	writeJSON(w, http.StatusOK, audioOpusResponse{
		OggBase64:  base64.StdEncoding.EncodeToString(ogg),
		Bytes:      len(ogg),
		DurationMs: durationMs,
		Encoder:    "native_libopus",
	})
}
