# UMRAIO Real-Time Voice Media Gateway
# Media plane only. No Meta, Supabase, ASR or TTS credentials are ever built in.

FROM golang:1.26.7-alpine AS build
WORKDIR /src

# Toolchain is pinned by go.mod; do not allow silent upgrades.
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux

COPY go.mod go.sum ./
RUN go mod download && go mod verify

COPY . .
RUN go vet ./... && go test ./... && \
    go build -trimpath -ldflags="-s -w" -o /out/gateway ./cmd/gateway

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/gateway /gateway
USER nonroot:nonroot

EXPOSE 8080/tcp
EXPOSE 40000/udp

ENTRYPOINT ["/gateway"]
