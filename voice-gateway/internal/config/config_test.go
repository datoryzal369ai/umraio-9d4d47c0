package config

import (
	"errors"
	"testing"
)

func TestAssertNoForbiddenEnvRejectsCredentials(t *testing.T) {
	for _, k := range ForbiddenEnv {
		lookup := func(key string) (string, bool) {
			if key == k {
				return "leaked-value", true
			}
			return "", false
		}
		if err := AssertNoForbiddenEnv(lookup); !errors.Is(err, ErrForbiddenEnv) {
			t.Fatalf("media plane must reject %s, got %v", k, err)
		}
	}
}

func TestAssertNoForbiddenEnvAllowsCleanEnvironment(t *testing.T) {
	lookup := func(string) (string, bool) { return "", false }
	if err := AssertNoForbiddenEnv(lookup); err != nil {
		t.Fatalf("clean environment rejected: %v", err)
	}
}

func TestLoadRequiresStrongSecretAndBackend(t *testing.T) {
	t.Setenv("UMRAIO_GATEWAY_SECRET", "short")
	t.Setenv("UMRAIO_BACKEND_URL", "https://example.com")
	if _, err := Load(); err == nil {
		t.Fatal("expected rejection of short secret")
	}
	t.Setenv("UMRAIO_GATEWAY_SECRET", "0123456789abcdef0123456789abcdef0123456789")
	t.Setenv("UMRAIO_BACKEND_URL", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected rejection of missing backend url")
	}
	t.Setenv("UMRAIO_BACKEND_URL", "http://insecure.example.com")
	if _, err := Load(); err == nil {
		t.Fatal("expected rejection of non-https backend url")
	}
	t.Setenv("UMRAIO_BACKEND_URL", "https://example.com")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("expected valid config: %v", err)
	}
	if cfg.UDPPortMin != 40000 || cfg.UDPPortMax != 40100 {
		t.Fatalf("unexpected udp range %d-%d", cfg.UDPPortMin, cfg.UDPPortMax)
	}
}

func TestLoadFailsWhenCredentialLeaksIntoContainer(t *testing.T) {
	t.Setenv("UMRAIO_GATEWAY_SECRET", "0123456789abcdef0123456789abcdef0123456789")
	t.Setenv("UMRAIO_BACKEND_URL", "https://example.com")
	t.Setenv("SUPABASE_SERVICE_ROLE_KEY", "should-not-be-here")
	if _, err := Load(); !errors.Is(err, ErrForbiddenEnv) {
		t.Fatalf("expected ErrForbiddenEnv, got %v", err)
	}
}
