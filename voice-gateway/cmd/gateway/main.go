// Command gateway is the UMRAIO real-time voice media plane.
//
// It terminates WebRTC/ICE/DTLS-SRTP/RTP/Opus for inbound WhatsApp calls and
// reports media lifecycle to the UMRAIO control plane over signed HTTP.
// It holds no Meta, Supabase, ASR or TTS credentials and makes no business
// decisions. It never asserts that a call was answered — only that media is
// genuinely flowing.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	pion "github.com/pion/webrtc/v4"

	"github.com/umraio/voice-gateway/internal/api"
	"github.com/umraio/voice-gateway/internal/auth"
	"github.com/umraio/voice-gateway/internal/callback"
	"github.com/umraio/voice-gateway/internal/config"
	"github.com/umraio/voice-gateway/internal/health"
	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/session"
	gwrtc "github.com/umraio/voice-gateway/internal/webrtc"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("configuration rejected", "error_class", "config")
		os.Exit(1)
	}

	var iceServers []pion.ICEServer
	if len(cfg.TurnURLs) > 0 {
		iceServers = append(iceServers, pion.ICEServer{
			URLs:       cfg.TurnURLs,
			Username:   cfg.TurnUsername,
			Credential: cfg.TurnCredential,
		})
	}

	engine, err := gwrtc.NewEngine(gwrtc.Config{
		UDPPortMin:  cfg.UDPPortMin,
		UDPPortMax:  cfg.UDPPortMax,
		NAT1To1IPs:  cfg.PublicIPs,
		ICEServers:  iceServers,
		NegotiateTO: cfg.NegotiateTimeout,
	})
	if err != nil {
		logger.Error("webrtc engine failed to start", "error_class", "webrtc")
		os.Exit(1)
	}

	registry := session.NewRegistry(cfg.MaxConcurrent)
	// Phase 3: real conversation loop. ASR, reasoning and TTS stay in the
	// control plane; the gateway only segments, ships and plays audio.
	turns := callback.NewTurnClient(cfg.BackendURL, cfg.Secret, 20*time.Second)
	srv := &api.Server{
		Secret:   cfg.Secret,
		Engine:   engine,
		Registry: registry,
		Replay:   auth.NewReplayGuard(2 * auth.MaxTokenLifetime),
		Events:   callback.New(cfg.BackendURL, cfg.Secret, cfg.CallbackTimeout, cfg.CallbackRetryMax, cfg.CallbackRetryBase),
		Logger:   logger,
		NewPipeline: func(callID string) umedia.Pipeline {
			return umedia.NewConversationPipeline(callID, turns, umedia.ConversationConfig{
				Greet: true,
			}, logger)
		},
	}

	var webrtcReady, draining atomic.Bool
	webrtcReady.Store(true)

	h := &health.Handler{
		Version:        cfg.BuildVersion,
		WebRTCReady:    &webrtcReady,
		ActiveSessions: registry.Count,
		Draining:       &draining,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", h.Health)
	mux.HandleFunc("GET /ready", h.Ready)
	srv.Routes(mux)

	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	reaperDone := make(chan struct{})
	go func() {
		defer close(reaperDone)
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for range t.C {
			srv.Reap(cfg.MaxCallDuration, cfg.NegotiateTimeout*3)
		}
	}()

	go func() {
		logger.Info("gateway listening", "addr", cfg.Addr, "build_version", cfg.BuildVersion,
			"udp_min", cfg.UDPPortMin, "udp_max", cfg.UDPPortMax, "max_concurrent", cfg.MaxConcurrent)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server stopped", "error_class", "http")
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	draining.Store(true)
	logger.Info("draining", "active_sessions", registry.Count())
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
	logger.Info("gateway stopped")
}
