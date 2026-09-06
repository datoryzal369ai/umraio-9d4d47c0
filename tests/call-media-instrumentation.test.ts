/**
 * UMRAIO® — Step E: additive media-plane instrumentation.
 *
 * These tests pin the telemetry contract only: bounded parsing of the
 * gateway's media metrics, their persistence into the existing voice_latency
 * entries, the latency summary, and an explicit failure reason on every
 * failed/terminated call session. No conversational behaviour is asserted here.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_MEDIA_METRIC_MS,
  parseMediaMetrics,
  parseVoiceTurnRequest,
} from "@/lib/calls/voice-turn.core";
import { appendLatency, summarizeLatency, type TurnLatency } from "@/lib/calls/call-experience.core";
import { mergeCallTimings } from "@/lib/calls/call-timings.core";

describe("gateway media metrics parsing", () => {
  it("accepts bounded, non-negative integers only", () => {
    expect(
      parseMediaMetrics({
        vad_finalize_ms: 700,
        prev_sequence: 3,
        tts_ms: 480.6,
        tts_encode_ms: 11,
        playback_start_ms: 900,
        speech_end_to_first_audio_ms: 1600,
      }),
    ).toEqual({
      vad_finalize_ms: 700,
      prev_sequence: 3,
      tts_ms: 480,
      tts_encode_ms: 11,
      playback_start_ms: 900,
      speech_end_to_first_audio_ms: 1600,
    });
  });

  it("drops negative, non-numeric and out-of-range values", () => {
    expect(
      parseMediaMetrics({
        vad_finalize_ms: -5,
        tts_ms: "fast",
        playback_start_ms: MAX_MEDIA_METRIC_MS + 1,
        speech_end_to_first_audio_ms: 1200,
      }),
    ).toEqual({ speech_end_to_first_audio_ms: 1200 });
    expect(parseMediaMetrics({})).toBeNull();
    expect(parseMediaMetrics(null)).toBeNull();
    expect(parseMediaMetrics([1, 2])).toBeNull();
  });

  it("is optional: an existing turn request without metrics still parses", () => {
    const request = parseVoiceTurnRequest({
      call_id: "wacid_1",
      sequence: 2,
      kind: "utterance",
      audio_ogg_base64: "T2dnUw==",
      duration_ms: 900,
    });
    expect(request?.media_metrics).toBeUndefined();
    expect(request?.kind).toBe("utterance");
  });

  it("carries metrics through the strict turn parser", () => {
    const request = parseVoiceTurnRequest({
      call_id: "wacid_1",
      sequence: 2,
      kind: "utterance",
      audio_ogg_base64: "T2dnUw==",
      duration_ms: 900,
      media_metrics: { vad_finalize_ms: 700, prev_sequence: 1, tts_ms: 500 },
    });
    expect(request?.media_metrics).toEqual({
      vad_finalize_ms: 700,
      prev_sequence: 1,
      tts_ms: 500,
    });
  });
});

describe("latency summary", () => {
  const entry = (seq: number, media?: TurnLatency["media"]): TurnLatency => ({
    seq,
    kind: "utterance",
    asr_ms: 800,
    context_ms: 120,
    reasoning_ms: 900,
    tts_ms: 0,
    total_ms: 1900,
    fast_path: false,
    ...(media ? { media } : {}),
  });

  it("reports media percentiles when the gateway measured them", () => {
    const entries = appendLatency(
      [entry(1, { vad_finalize_ms: 700, tts_ms: 400, tts_encode_ms: 10, playback_start_ms: 800, speech_end_to_first_audio_ms: 1500 })],
      entry(2, { vad_finalize_ms: 720, tts_ms: 600, tts_encode_ms: 14, playback_start_ms: 1000, speech_end_to_first_audio_ms: 1900 }),
    );
    const stats = summarizeLatency(entries);
    expect(stats["p50_speech_end_to_first_audio_ms"]).toBe(1500);
    expect(stats["p95_speech_end_to_first_audio_ms"]).toBe(1900);
    expect(stats["p50_media_tts_ms"]).toBe(400);
    expect(stats["p50_vad_finalize_ms"]).toBe(700);
    expect(stats["p50_playback_start_ms"]).toBe(800);
  });

  it("omits media percentiles entirely when nothing was measured", () => {
    const stats = summarizeLatency([entry(1)]);
    expect(stats["p50_speech_end_to_first_audio_ms"]).toBeUndefined();
    expect(stats["p50_total_ms"]).toBe(1900);
  });
});

describe("failure reason on call timings", () => {
  it("persists and preserves an explicit reason", () => {
    const first = mergeCallTimings(
      { webhook_received_at: "2026-09-10T00:00:00.000Z" },
      { terminate_received_at: "2026-09-10T00:00:20.000Z", failure_reason: "peer_disconnected" },
    );
    expect(first.failure_reason).toBe("peer_disconnected");
    expect(first.durations_ms?.["webhook_to_terminate"]).toBe(20000);

    // A later timing merge must not erase the recorded reason.
    const second = mergeCallTimings(first, { media_ready_at: "2026-09-10T00:00:21.000Z" });
    expect(second.failure_reason).toBe("peer_disconnected");
  });
});
