package callback

// Loopback HTTP only: the real TurnClient signs and sends to a synthetic
// Worker. No Fly, Meta, production Worker, provider, or external network call.
import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/umraio/voice-gateway/internal/auth"
	"github.com/umraio/voice-gateway/internal/media"
)

type cancellationHTTPResult struct {
	err, contextErr error
	reply           *media.TurnResponse
}
type cancellationHTTPClient struct {
	inner  *TurnClient
	result chan cancellationHTTPResult
}

func (c *cancellationHTTPClient) Turn(ctx context.Context, req media.TurnRequest) (*media.TurnResponse, error) {
	return c.TurnStream(ctx, req, func(media.TurnResponse) {})
}
func (c *cancellationHTTPClient) TurnStream(ctx context.Context, req media.TurnRequest, ack func(media.TurnResponse)) (*media.TurnResponse, error) {
	r, e := c.inner.TurnStream(ctx, req, ack)
	c.result <- cancellationHTTPResult{e, ctx.Err(), r}
	return r, e
}

type cancellationHTTPTransport struct{ sent atomic.Int64 }

func (tr *cancellationHTTPTransport) SendOpus(media.OpusFrame) error { tr.sent.Add(1); return nil }
func (*cancellationHTTPTransport) Terminate(string)                  {}

// Observe the real client's first response-body read, rather than assuming
// server Flush means the client has already consumed the response headers.
type cancellationReadObserver struct {
	http.RoundTripper
	reading chan struct{}
}

func (o cancellationReadObserver) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := o.RoundTripper.RoundTrip(r)
	if err == nil {
		resp.Body = &cancellationObservedBody{ReadCloser: resp.Body, reading: o.reading}
	}
	return resp, err
}

type cancellationObservedBody struct {
	io.ReadCloser
	reading chan struct{}
	once    sync.Once
}

func (b *cancellationObservedBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.reading) })
	return b.ReadCloser.Read(p)
}

func cancellationAwait[T any](t *testing.T, c <-chan T) T {
	t.Helper()
	select {
	case value := <-c:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("loopback cancellation lifecycle did not settle")
	}
	var zero T
	return zero
}

func TestCancellationHTTPOnlyQualifiedVADDisconnectsPendingWorker(t *testing.T) {
	for _, headers := range []bool{false, true} {
		name := "before_response_headers"
		if headers {
			name = "while_reading_streamed_response_body"
		}
		t.Run(name, func(t *testing.T) {
			ready := make(chan media.TurnRequest, 1)
			cancelled := make(chan error, 1)
			exited := make(chan struct{}, 1)
			release := make(chan struct{})
			var requests atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer func() { exited <- struct{}{} }()
				requests.Add(1)
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					return
				}
				if r.Method != "POST" || r.URL.Path != TurnPath || auth.VerifyRequest("synthetic-only", r.Header.Get(auth.SignatureHeader), r.Header.Get(auth.TimestampHeader), body, time.Now()) != nil {
					t.Error("existing signed Worker contract changed")
					w.WriteHeader(401)
					return
				}
				var req media.TurnRequest
				if err := json.Unmarshal(body, &req); err != nil {
					t.Error(err)
					return
				}
				if headers {
					w.Header().Set("Content-Type", "application/x-ndjson")
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
				}
				ready <- req
				select {
				case <-r.Context().Done():
					cancelled <- r.Context().Err()
				case <-release:
				}
			}))
			t.Cleanup(server.Close)
			t.Cleanup(func() { close(release) })
			client := &cancellationHTTPClient{inner: NewTurnClient(server.URL, "synthetic-only", 20*time.Second), result: make(chan cancellationHTTPResult, 1)}
			reading := make(chan struct{})
			if headers {
				client.inner.http.Transport = cancellationReadObserver{http.DefaultTransport, reading}
			}
			p := media.NewConversationPipeline("synthetic-http-cancel", client, media.ConversationConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			tr := &cancellationHTTPTransport{}
			if err := p.Attach(context.Background(), tr); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { p.Close("test_cleanup") })
			p.StartGreeting() // records accepted; greeting disabled for this boundary test
			push := func(n, size int) {
				for i := 0; i < n; i++ {
					p.OnInbound(media.OpusFrame{Data: make([]byte, size), Duration: 20 * time.Millisecond})
				}
			}
			push(25, 120)
			push(35, 3)
			req := cancellationAwait(t, ready)
			if headers {
				cancellationAwait(t, reading)
			}
			if req.Kind != media.TurnKindUtterance || req.Sequence != 1 || req.DurationMs != 1200 || req.AudioOggBase64 == "" {
				t.Fatal("valid finalized utterance was not delivered")
			}
			push(2, 40)
			select {
			case <-cancelled:
				t.Fatal("two-frame activity cancelled request")
			default:
			}
			push(1, 40) // third frame is provisional, not authority to abort HTTP
			select {
			case <-client.result:
				t.Fatal("short VAD cancelled the valid Worker request")
			default:
			}
			push(35, 3)  // discard the pulse; no replacement request
			push(15, 40) // 300ms is still provisional
			select {
			case <-client.result:
				t.Fatal("cancelled before sufficient speech evidence")
			default:
			}
			push(1, 40) // 320ms qualifies; still before utterance finalization
			if err := cancellationAwait(t, cancelled); !errors.Is(err, context.Canceled) {
				t.Fatalf("server request cause: %v", err)
			}
			result := cancellationAwait(t, client.result)
			if !errors.Is(result.contextErr, context.Canceled) || result.reply != nil || result.err == nil {
				t.Fatalf("wrong cancellation result: %+v", result)
			}
			if headers && result.err.Error() != "turn: stream read failed" {
				t.Fatalf("body read classification: %v", result.err)
			}
			if !headers && !errors.Is(result.err, context.Canceled) {
				t.Fatalf("request classification: %v", result.err)
			}
			cancellationAwait(t, exited)
			p.Close("test_done")
			if requests.Load() != 1 || tr.sent.Load() != 0 || p.Turns() != 1 {
				t.Fatal("duplicate dispatch or cancelled response audio")
			}
		})
	}
}

func TestCancellationHTTPDeadlineIsDistinctFromProvisionalSpeech(t *testing.T) {
	ready := make(chan struct{}, 1)
	exited := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		ready <- struct{}{}
		<-r.Context().Done()
		exited <- struct{}{}
	}))
	defer server.Close()
	parent, stop := context.WithCancel(context.Background())
	defer stop()
	ctx, cancel := context.WithTimeout(parent, 20*time.Millisecond)
	defer cancel()
	client := NewTurnClient(server.URL, "synthetic-only", 20*time.Second)
	done := make(chan error, 1)
	go func() {
		_, err := client.TurnStream(ctx, media.TurnRequest{}, func(media.TurnResponse) {})
		done <- err
	}()
	cancellationAwait(t, ready)
	err := cancellationAwait(t, done)
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline cause: %v / %v", ctx.Err(), err)
	}
	cancellationAwait(t, exited)
}
