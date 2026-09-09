package tts

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

type cancellationRoundTripper func(*http.Request) (*http.Response, error)

func (f cancellationRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

type cancelledResponseBody struct{ ctx context.Context }

func (r cancelledResponseBody) Read([]byte) (int, error) {
	<-r.ctx.Done()
	return 0, fmt.Errorf("synthetic-private-transport-detail: %w", r.ctx.Err())
}
func (cancelledResponseBody) Close() error { return nil }

func TestTTSCancellationClassification(t *testing.T) {
	for _, phase := range []string{"headers", "body"} {
		for _, cause := range []string{"cancelled", "timeout"} {
			t.Run(phase+"/"+cause, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					c := NewClient(Config{APIKey: "synthetic-key", Timeout: time.Second})
					entered := make(chan struct{})
					c.http.Transport = cancellationRoundTripper(func(r *http.Request) (*http.Response, error) {
						close(entered)
						if phase == "body" {
							return &http.Response{StatusCode: 200, Header: make(http.Header), Body: cancelledResponseBody{r.Context()}}, nil
						}
						<-r.Context().Done()
						return nil, fmt.Errorf("synthetic-private-transport-detail: %w", r.Context().Err())
					})
					result := make(chan error, 1)
					go func() {
						_, err := c.SynthesizePCM(ctx, "synthetic-private-text", "", "")
						result <- err
					}()
					<-entered
					want := context.DeadlineExceeded
					if cause == "cancelled" {
						cancel()
						want = context.Canceled
					}
					err := <-result // timeout advances only the virtual clock
					if !errors.Is(err, want) || errors.Is(err, ErrProvider) || classOf(err) != cause {
						t.Fatalf("want %s, not provider: got %v / %s", cause, err, classOf(err))
					}
					if cause == "timeout" && ctx.Err() != nil {
						t.Fatal("HTTP timeout test must leave the parent turn live")
					}
					if strings.Contains(err.Error(), "synthetic-") {
						t.Fatal("cancellation exposed raw HTTP error or request data")
					}
				})
			})
		}
	}
}

func TestTTSGenuineProviderFailureRemainsProvider(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"http", 401, `{"message":"synthetic-private-body"}`, "http 401"},
		{"minimax_status", 200, `{"base_resp":{"status_code":2053,"status_msg":"synthetic-private-body"}}`, "status 2053"},
		{"decode", 200, `synthetic-private-body`, "decode"},
		{"transport", 0, "", "transport"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := NewClient(Config{APIKey: "synthetic-key"})
			c.http.Transport = cancellationRoundTripper(func(*http.Request) (*http.Response, error) {
				if tc.status == 0 {
					return nil, errors.New("synthetic-private-transport-detail")
				}
				return &http.Response{StatusCode: tc.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})
			_, err := c.SynthesizePCM(context.Background(), "synthetic-private-text", "", "")
			if !errors.Is(err, ErrProvider) || classOf(err) != "provider" || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("genuine %s lost classification: %v", tc.name, err)
			}
			if strings.Contains(err.Error(), "synthetic-") {
				t.Fatal("provider error exposed request or response data")
			}
		})
	}
}

func TestTTSSpeakerLogsCancellationNotProvider(t *testing.T) {
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
		t.Run(cause.Error(), func(t *testing.T) {
			var buf bytes.Buffer
			s := NewSpeaker(Config{APIKey: "synthetic-key"}, slog.New(slog.NewJSONHandler(&buf, nil)))
			s.client.http.Transport = cancellationRoundTripper(func(*http.Request) (*http.Response, error) {
				return nil, fmt.Errorf("synthetic-private-detail: %w", cause)
			})
			packets, _, _, err := s.SpeakTimed(context.Background(), "synthetic-call", "synthetic-private-text", "", "")
			if len(packets) != 0 || !errors.Is(err, cause) {
				t.Fatalf("cancelled synthesis returned audio or wrong cause: %v", err)
			}
			line := buf.String()
			if !strings.Contains(line, `"error_class":"`+classOf(cause)+`"`) || strings.Contains(line, `"error_class":"provider"`) || strings.Contains(line, "synthetic-private") || strings.Contains(line, "synthetic-key") {
				t.Fatalf("cancellation log misclassified or leaked data: %s", line)
			}
		})
	}
}
