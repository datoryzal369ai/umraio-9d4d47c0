# UMRAIO Real-Time Voice Media Gateway (Phase 1)

Isolated **media plane** for inbound WhatsApp Business calls. It is a separate
service from the UMRAIO application and is **not deployed**.

## Boundary

The gateway owns only: WebRTC, ICE, DTLS/SRTP, RTP, Opus, bidirectional audio
transport, media readiness and media termination.

It has **no** access to Supabase, the database, Meta access tokens, WhatsApp
credentials, agency membership, CRM, DNC, quotations or payments. `config.Load`
fails closed if any of those credentials appear in the container environment.

The UMRAIO Cloudflare Worker remains the control plane and the only authority on
business call state.

## The answered rule

The gateway emits `media_ready` **only** when all of the following hold:

1. the session token was valid and matched the `call_id`,
2. the peer connection reached `connected` (ICE + DTLS),
3. at least one real inbound RTP audio packet was received,
4. an outbound RTP path exists,
5. the session is not terminal.

SDP exchange, HTTP 200 and PeerConnection creation are explicitly insufficient.
`media_ready` is emitted at most once per call. The Worker still requires a
successful Meta `accept` in addition to `media_ready` before marking a call
answered.

## Endpoints

Authenticated (Bearer session token + `X-Umraio-Signature` / `X-Umraio-Timestamp`):

- `POST /v1/calls/offer`
- `POST /v1/calls/{callID}/terminate`
- `GET  /v1/calls/{callID}`

Public:

- `GET /health`
- `GET /ready`

## Environment

| Variable | Required | Default |
|---|---|---|
| `UMRAIO_GATEWAY_SECRET` | yes (>= 32 chars) | — |
| `UMRAIO_BACKEND_URL` | yes (https) | — |
| `LISTEN_ADDR` | no | `:8080` |
| `PUBLIC_IP` | prod | — |
| `UDP_PORT_MIN` / `UDP_PORT_MAX` | no | `40000` / `40100` |
| `MAX_CONCURRENT_CALLS` | no | `25` |
| `MAX_CALL_DURATION_S` | no | `600` |
| `MEDIA_NEGOTIATE_TIMEOUT_S` | no | `10` |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | no | — |
| `CALLBACK_TIMEOUT_S` / `CALLBACK_RETRY_MAX` / `CALLBACK_RETRY_BASE_MS` | no | `5` / `3` / `200` |
| `BUILD_VERSION`, `LOG_LEVEL` | no | `dev`, `info` |

## Local validation

```
go build ./...
go vet ./...
go test ./...
go test -race ./...
```

## Not done in Phase 1

No ASR, no TTS, no AI conversation. `media.Pipeline` is the seam those land
behind in a later phase; Phase 1 ships `NoopPipeline`.
