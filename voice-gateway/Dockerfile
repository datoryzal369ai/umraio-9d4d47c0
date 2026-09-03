# UMRAIO Real-Time Voice Media Gateway
# Media plane only. No Meta, Supabase or ASR credentials are ever built in.
# The ONLY provider credential this plane may hold at runtime is
# MINIMAX_TTS_API_KEY: Opus encoding is impossible in the serverless control
# plane, so speech synthesis + libopus encoding live next to the RTP sender.

FROM golang:1.26.7-alpine AS build
WORKDIR /src

# Toolchain is pinned by go.mod; do not allow silent upgrades.
# CGO is REQUIRED: the Opus encoder binds native libopus.
ENV GOTOOLCHAIN=local CGO_ENABLED=1 GOOS=linux

RUN apk add --no-cache build-base pkgconf opus-dev opusfile-dev libogg-dev

COPY go.mod go.sum ./
RUN go mod download && go mod verify

COPY . .
RUN go vet ./... && go test ./... && \
    go build -trimpath -ldflags="-s -w" -o /out/gateway ./cmd/gateway

FROM alpine:3.22
WORKDIR /
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=${BUILD_VERSION}
RUN apk add --no-cache opus opusfile libogg ca-certificates && \
    adduser -D -H -u 10001 nonroot
COPY --from=build /out/gateway /gateway
USER nonroot:nonroot

EXPOSE 8080/tcp
EXPOSE 40000/udp

ENTRYPOINT ["/gateway"]
