// Command gateway is the UMRAIO real-time voice media plane.
//
// It terminates WebRTC/ICE/DTLS-SRTP/RTP/Opus for inbound WhatsApp calls and
// reports media lifecycle to the UMRAIO control plane over signed HTTP.
// It holds no Meta, Supabase or ASR credentials and makes no business
// decisions. Its ONLY provider credential is MINIMAX_TTS_API_KEY, because
// Opus encoding is impossible in the serverless control plane. It never asserts that a call was answered — only that media is
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
	"github.com/umraio/voice-gateway/internal/tts"
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

	// Single fixed UDP media port, dual-stack. IPv4 binds Fly's special
	// services address and fails closed; IPv6 binds the wildcard and is
	// best-effort so a v6-less host still serves media.
	udpMux, udpConns, v6Err, muxErr := gwrtc.NewDualStackUDPMux(cfg.UDPMediaHost, cfg.UDPMediaHost6, cfg.UDPMediaPort)
	if muxErr != nil {
		logger.Error("udp media listener failed to bind", "error_class", "udp_mux",
			"host", cfg.UDPMediaHost, "port", cfg.UDPMediaPort, "error", muxErr.Error())
		os.Exit(1)
	}
	if v6Err != nil {
		logger.Warn("ipv6 media listener unavailable", "error_class", "udp_mux_v6",
			"host6", cfg.UDPMediaHost6, "port", cfg.UDPMediaPort)
	}
	natV4, natV6 := gwrtc.IPFamilies(cfg.PublicIPs)
	logger.Info("media sockets bound",
		"udp_socket_count", len(udpConns),
		"ipv6_socket_bound", v6Err == nil && cfg.UDPMediaHost6 != "",
		"nat_1to1_ipv4_count", natV4, "nat_1to1_ipv6_count", natV6)
	defer func() {
		for _, c := range udpConns {
			_ = c.Close()
		}
	}()

	engine, err := gwrtc.NewEngine(gwrtc.Config{
		UDPMux:      udpMux,
		NAT1To1IPs:  cfg.PublicIPs,
		ICEServers:  iceServers,
		NegotiateTO: cfg.NegotiateTimeout,
		Logger:      logger,
	})
	if err != nil {
		logger.Error("webrtc engine failed to start", "error_class", "webrtc")
		os.Exit(1)
	}

	registry := session.NewRegistry(cfg.MaxConcurrent)
	// Phase 3: real conversation loop. ASR and reasoning stay in the control
	// plane. SPEECH lives here: the serverless Worker cannot compile an Opus
	// encoder, so MiniMax synthesis + libopus encoding run next to the RTP
	// sender. MINIMAX_TTS_API_KEY is the ONLY provider credential this plane
	// is allowed to hold; every other credential stays forbidden.
	turns := callback.NewTurnClient(cfg.BackendURL, cfg.Secret, 20*time.Second)
	var speaker *tts.Speaker
	if ttsCfg, ok := tts.EnvConfig(); ok {
		speaker = tts.NewSpeaker(ttsCfg, logger)
	}
	logger.Info("tts_capability",
		"configured", speaker != nil,
		"encoder", tts.EncoderAvailable(),
		"model", tts.DefaultModel, "voice", tts.DefaultVoiceID)
	srv := &api.Server{
		Secret:   cfg.Secret,
		Engine:   engine,
		Registry: registry,
		Replay:   auth.NewReplayGuard(2 * auth.MaxTokenLifetime),
		Events:   callback.New(cfg.BackendURL, cfg.Secret, cfg.CallbackTimeout, cfg.CallbackRetryMax, cfg.CallbackRetryBase),
		Logger:   logger,
		NewPipeline: func(callID string) umedia.Pipeline {
			p := umedia.NewConversationPipeline(callID, turns, umedia.ConversationConfig{
				Greet: true,
			}, logger)
			if speaker != nil {
				p = p.WithSynthesizer(speaker)
			}
			return p
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
			"udp_media_host", cfg.UDPMediaHost, "udp_media_port", cfg.UDPMediaPort,
			"max_concurrent", cfg.MaxConcurrent)
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
	if err := udpMux.Close(); err != nil {
		logger.Warn("udp mux close failed", "error_class", "udp_mux")
	}
	for _, c := range udpConns {
		_ = c.Close()
	}
	logger.Info("gateway stopped")
}
