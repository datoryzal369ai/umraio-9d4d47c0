// Package config loads gateway configuration from the environment. It never
// reads or accepts Meta, Supabase, ASR or TTS credentials.
package config

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr              string
	BackendURL        string
	Secret            string
	PublicIPs         []string
	UDPMediaHost      string
	UDPMediaPort      int
	MaxConcurrent     int
	MaxCallDuration   time.Duration
	NegotiateTimeout  time.Duration
	TurnURLs          []string
	TurnUsername      string
	TurnCredential    string
	BuildVersion      string
	LogLevel          string
	CallbackTimeout   time.Duration
	CallbackRetryMax  int
	CallbackRetryBase time.Duration
}

// ForbiddenEnv are variables that must never be present in the media plane.
var ForbiddenEnv = []string{
	"WHATSAPP_ACCESS_TOKEN", "META_ACCESS_TOKEN", "SUPABASE_SERVICE_ROLE_KEY",
	"SUPABASE_URL", "OPENAI_API_KEY", "MINIMAX_API_KEY", "LOVABLE_API_KEY",
	"XIAOZHI_API_KEY",
}

var ErrForbiddenEnv = errors.New("config: forbidden credential present in media plane environment")

// AssertNoForbiddenEnv fails closed if a credential leaks into the container.
func AssertNoForbiddenEnv(lookup func(string) (string, bool)) error {
	for _, k := range ForbiddenEnv {
		if v, ok := lookup(k); ok && strings.TrimSpace(v) != "" {
			return ErrForbiddenEnv
		}
	}
	return nil
}

func Load() (Config, error) {
	c := Config{
		Addr:              envStr("LISTEN_ADDR", ":8080"),
		BackendURL:        strings.TrimRight(envStr("UMRAIO_BACKEND_URL", ""), "/"),
		Secret:            envStr("UMRAIO_GATEWAY_SECRET", ""),
		UDPMediaHost:      envStr("UDP_MEDIA_HOST", "fly-global-services"),
		UDPMediaPort:      envInt("UDP_MEDIA_PORT", 40000),
		MaxConcurrent:     envInt("MAX_CONCURRENT_CALLS", 25),
		MaxCallDuration:   time.Duration(envInt("MAX_CALL_DURATION_S", 600)) * time.Second,
		NegotiateTimeout:  time.Duration(envInt("MEDIA_NEGOTIATE_TIMEOUT_S", 10)) * time.Second,
		TurnUsername:      envStr("TURN_USERNAME", ""),
		TurnCredential:    envStr("TURN_CREDENTIAL", ""),
		BuildVersion:      envStr("BUILD_VERSION", "dev"),
		LogLevel:          envStr("LOG_LEVEL", "info"),
		CallbackTimeout:   time.Duration(envInt("CALLBACK_TIMEOUT_S", 5)) * time.Second,
		CallbackRetryMax:  envInt("CALLBACK_RETRY_MAX", 3),
		CallbackRetryBase: time.Duration(envInt("CALLBACK_RETRY_BASE_MS", 200)) * time.Millisecond,
	}
	c.PublicIPs = splitList(envStr("PUBLIC_IP", ""))
	c.TurnURLs = splitList(envStr("TURN_URLS", ""))

	if c.Secret == "" {
		return c, errors.New("config: UMRAIO_GATEWAY_SECRET is required")
	}
	if len(c.Secret) < 32 {
		return c, errors.New("config: UMRAIO_GATEWAY_SECRET must be at least 32 characters")
	}
	if c.BackendURL == "" {
		return c, errors.New("config: UMRAIO_BACKEND_URL is required")
	}
	if !strings.HasPrefix(c.BackendURL, "https://") && !strings.HasPrefix(c.BackendURL, "http://127.0.0.1") {
		return c, errors.New("config: UMRAIO_BACKEND_URL must be https")
	}
	if c.UDPMediaPort <= 0 || c.UDPMediaPort > 65535 {
		return c, errors.New("config: UDP_MEDIA_PORT must be a valid port")
	}
	if c.UDPMediaHost == "" {
		return c, errors.New("config: UDP_MEDIA_HOST must not be empty")
	}
	return c, AssertNoForbiddenEnv(os.LookupEnv)
}

func envStr(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}

func envInt(k string, def int) int {
	if v, ok := os.LookupEnv(k); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

func splitList(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
