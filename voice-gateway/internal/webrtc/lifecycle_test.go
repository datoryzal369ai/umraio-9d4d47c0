package webrtc

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"

	umedia "github.com/umraio/voice-gateway/internal/media"
	"github.com/umraio/voice-gateway/internal/session"
)

type lifecyclePipeline struct {
	closes       atomic.Int64
	startedOnce  sync.Once
	closeStarted chan struct{}
	closeRelease chan struct{}
}

func newLifecyclePipeline(blockClose bool) *lifecyclePipeline {
	p := &lifecyclePipeline{
		closeStarted: make(chan struct{}),
	}
	if blockClose {
		p.closeRelease = make(chan struct{})
	}
	return p
}

func (p *lifecyclePipeline) Attach(context.Context, umedia.Transport) error { return nil }
func (p *lifecyclePipeline) OnInbound(umedia.OpusFrame)                     {}
func (p *lifecyclePipeline) Close(string) {
	p.closes.Add(1)
	p.startedOnce.Do(func() { close(p.closeStarted) })
	if p.closeRelease != nil {
		<-p.closeRelease
	}
}

func newLifecycleMediaSession(
	t *testing.T,
	pipeline umedia.Pipeline,
	hooks Hooks,
) (*MediaSession, *session.Session) {
	t.Helper()
	pc, err := pion.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatalf("peer connection: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	out, err := pion.NewTrackLocalStaticSample(
		pion.RTPCodecCapability{MimeType: pion.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio",
		"lifecycle-test",
	)
	if err != nil {
		t.Fatalf("outbound track: %v", err)
	}

	sess := session.New("ms_lifecycle", "call-lifecycle", "agency", "phone", time.Now())
	ms := &MediaSession{
		pc:           pc,
		out:          out,
		sess:         sess,
		pipeline:     pipeline,
		hooks:        hooks,
		log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		pipelineMode: umedia.PipelineMode(pipeline),
	}
	return ms, sess
}

func awaitLifecycleHook(t *testing.T, hook <-chan string) string {
	t.Helper()
	select {
	case reason := <-hook:
		return reason
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for terminal hook")
		return ""
	}
}

func assertNoAdditionalLifecycleHook(t *testing.T, hook <-chan string) {
	t.Helper()
	select {
	case reason := <-hook:
		t.Fatalf("terminal hook fired more than once; extra reason=%q", reason)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestTransientDisconnectedDoesNotTerminateAndCanReconnect(t *testing.T) {
	pipe := newLifecyclePipeline(false)
	var hooks atomic.Int64
	hook := make(chan string, 1)
	ms, sess := newLifecycleMediaSession(t, pipe, Hooks{OnTerminated: func(_ *session.Session, reason string) {
		hooks.Add(1)
		hook <- reason
	}})

	ms.handleConnectionState(pion.PeerConnectionStateDisconnected)
	ms.handleConnectionState(pion.PeerConnectionStateConnected)

	if session.IsTerminal(sess.State()) {
		t.Fatalf("transient disconnect terminated session: %s", sess.State())
	}
	if pipe.closes.Load() != 0 {
		t.Fatalf("pipeline closed %d times during recoverable disconnect", pipe.closes.Load())
	}
	if hooks.Load() != 0 {
		t.Fatalf("terminal hook fired %d times during recoverable disconnect", hooks.Load())
	}
	if sess.MediaReadyRule() {
		t.Fatal("reconnection without inbound RTP must not claim media readiness")
	}

	ms.Terminate("test_cleanup")
	if got := awaitLifecycleHook(t, hook); got != "test_cleanup" {
		t.Fatalf("cleanup hook reason = %q", got)
	}
}

func TestFailedRemainsFailedAndCleansUpExactlyOnce(t *testing.T) {
	pipe := newLifecyclePipeline(false)
	var hooks atomic.Int64
	hook := make(chan string, 1)
	ms, sess := newLifecycleMediaSession(t, pipe, Hooks{OnTerminated: func(_ *session.Session, reason string) {
		hooks.Add(1)
		hook <- reason
	}})

	ms.handleConnectionState(pion.PeerConnectionStateFailed)
	ms.handleConnectionState(pion.PeerConnectionStateClosed)
	ms.Terminate("duplicate_terminate")

	if got := awaitLifecycleHook(t, hook); got != "ice_failed" {
		t.Fatalf("terminal hook reason = %q, want ice_failed", got)
	}
	assertNoAdditionalLifecycleHook(t, hook)
	if sess.State() != session.StateFailed {
		t.Fatalf("failed state overwritten during cleanup: %s", sess.State())
	}
	if sess.TerminationReason() != "ice_failed" {
		t.Fatalf("failure reason = %q, want ice_failed", sess.TerminationReason())
	}
	if pipe.closes.Load() != 1 {
		t.Fatalf("pipeline close count = %d, want 1", pipe.closes.Load())
	}
	if hooks.Load() != 1 {
		t.Fatalf("terminal hook count = %d, want 1", hooks.Load())
	}
}

func TestClosedPerformsTerminalCleanupExactlyOnce(t *testing.T) {
	pipe := newLifecyclePipeline(false)
	var hooks atomic.Int64
	hook := make(chan string, 1)
	ms, sess := newLifecycleMediaSession(t, pipe, Hooks{OnTerminated: func(_ *session.Session, reason string) {
		hooks.Add(1)
		hook <- reason
	}})

	ms.handleConnectionState(pion.PeerConnectionStateClosed)
	ms.handleConnectionState(pion.PeerConnectionStateClosed)
	ms.Terminate("duplicate_terminate")

	if got := awaitLifecycleHook(t, hook); got != "peer_closed" {
		t.Fatalf("terminal hook reason = %q, want peer_closed", got)
	}
	assertNoAdditionalLifecycleHook(t, hook)
	if sess.State() != session.StateTerminated {
		t.Fatalf("closed session state = %s, want TERMINATED", sess.State())
	}
	if sess.TerminationReason() != "peer_closed" {
		t.Fatalf("termination reason = %q, want peer_closed", sess.TerminationReason())
	}
	if pipe.closes.Load() != 1 {
		t.Fatalf("pipeline close count = %d, want 1", pipe.closes.Load())
	}
	if hooks.Load() != 1 {
		t.Fatalf("terminal hook count = %d, want 1", hooks.Load())
	}
	if err := ms.SendOpus(umedia.OpusFrame{Data: []byte{0xf8, 0xff, 0xfe}}); !errors.Is(err, ErrClosed) {
		t.Fatalf("SendOpus after cleanup error = %v, want ErrClosed", err)
	}
}

func TestTerminateReturnsBeforeBlockingPipelineClose(t *testing.T) {
	pipe := newLifecyclePipeline(true)
	hook := make(chan string, 1)
	ms, sess := newLifecycleMediaSession(t, pipe, Hooks{OnTerminated: func(_ *session.Session, reason string) {
		hook <- reason
	}})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(pipe.closeRelease) }) }
	defer release()

	returned := make(chan struct{})
	go func() {
		ms.Terminate("caller_hangup")
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(250 * time.Millisecond):
		release()
		<-returned
		t.Fatal("Terminate blocked on pipeline.Close")
	}
	select {
	case <-pipe.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("asynchronous pipeline cleanup did not start")
	}
	if sess.State() != session.StateTerminated {
		t.Fatalf("state before resource cleanup = %s, want TERMINATED", sess.State())
	}
	select {
	case reason := <-hook:
		t.Fatalf("terminal hook fired before pipeline.Close finished: %q", reason)
	default:
	}

	release()
	if got := awaitLifecycleHook(t, hook); got != "caller_hangup" {
		t.Fatalf("terminal hook reason = %q", got)
	}
	if pipe.closes.Load() != 1 {
		t.Fatalf("pipeline close count = %d, want 1", pipe.closes.Load())
	}
}

type endCallTurnClient struct {
	calls atomic.Int64
}

func (c *endCallTurnClient) Turn(context.Context, umedia.TurnRequest) (*umedia.TurnResponse, error) {
	c.calls.Add(1)
	return &umedia.TurnResponse{EndCall: true, Reason: "conversation_complete"}, nil
}

func TestConversationEndCallDoesNotSelfWait(t *testing.T) {
	client := &endCallTurnClient{}
	pipe := umedia.NewConversationPipeline("call-lifecycle", client, umedia.ConversationConfig{
		Greet:       true,
		TurnTimeout: time.Second,
	}, nil)
	hook := make(chan string, 1)
	ms, sess := newLifecycleMediaSession(t, pipe, Hooks{OnTerminated: func(_ *session.Session, reason string) {
		hook <- reason
	}})
	if err := pipe.Attach(context.Background(), ms); err != nil {
		t.Fatalf("attach conversation pipeline: %v", err)
	}

	if got := ms.NotifyAccepted(); got != string(umedia.GreetingStarted) {
		t.Fatalf("greeting outcome = %q, want %q", got, umedia.GreetingStarted)
	}
	if got := awaitLifecycleHook(t, hook); got != "conversation_complete" {
		t.Fatalf("terminal hook reason = %q", got)
	}
	if client.calls.Load() != 1 {
		t.Fatalf("turn calls = %d, want 1", client.calls.Load())
	}
	if sess.State() != session.StateTerminated {
		t.Fatalf("conversation end state = %s, want TERMINATED", sess.State())
	}
	if sess.TerminationReason() != "conversation_complete" {
		t.Fatalf("conversation end reason = %q", sess.TerminationReason())
	}
}
