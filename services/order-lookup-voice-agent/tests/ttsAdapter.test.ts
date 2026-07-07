import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  AudioChunkAccumulator,
  MIN_AUDIO_CHUNK_BYTES,
  MAX_AUDIO_CHUNK_BYTES,
  normalizeAudioChunks,
  telephonyChunkBounds,
  ELEVENLABS_CIRCUIT_BREAKER_LOG,
  getConversationRelayTtsEngine,
  getIsElevenLabsDisabled,
  getPreferredVoiceForCall,
  markElevenLabsAuthFailure,
  resetElevenLabsCircuitBreakerForTests,
  synthesizeSpeech,
  tripElevenLabsCircuitBreaker,
} from "../src/adapters/ttsAdapter.js";
import { buildConversationRelayVoiceAttrs } from "../src/adapters/voiceAdapter.js";

describe("AudioChunkAccumulator", () => {
  it("buffers sub-minimum reads until a telephony frame is ready", () => {
    const acc = new AudioChunkAccumulator(MIN_AUDIO_CHUNK_BYTES, MAX_AUDIO_CHUNK_BYTES);
    expect(acc.ingest(Buffer.alloc(80))).toEqual([]);
    const ready = acc.ingest(Buffer.alloc(120));
    expect(ready).toHaveLength(1);
    expect(ready[0].length).toBe(200);
  });

  it("emits max-sized frames for large bursts", () => {
    const acc = new AudioChunkAccumulator(MIN_AUDIO_CHUNK_BYTES, MAX_AUDIO_CHUNK_BYTES);
    const ready = acc.ingest(Buffer.alloc(900));
    expect(ready.map((b) => b.length)).toEqual([400, 400]);
    expect(acc.drain()).toEqual([Buffer.alloc(100)]);
  });

  it("drains tail audio on stream end", () => {
    const acc = new AudioChunkAccumulator(MIN_AUDIO_CHUNK_BYTES, MAX_AUDIO_CHUNK_BYTES);
    expect(acc.ingest(Buffer.alloc(50))).toEqual([]);
    expect(acc.drain()).toEqual([Buffer.alloc(50)]);
  });
});

describe("telephonyChunkBounds", () => {
  it("uses 20–50 ms bounds for ulaw_8000", () => {
    expect(telephonyChunkBounds("ulaw_8000")).toEqual({
      minBytes: 160,
      maxBytes: 400,
    });
  });

  it("uses 20–50 ms bounds for pcm_16000", () => {
    expect(telephonyChunkBounds("pcm_16000")).toEqual({
      minBytes: 640,
      maxBytes: 1600,
    });
  });
});

describe("normalizeAudioChunks", () => {
  it("returns small buffers unchanged", () => {
    const small = Buffer.alloc(100);
    expect(normalizeAudioChunks(small, "ulaw_8000")).toBe(small);
  });
});

describe("ElevenLabs circuit breaker", () => {
  beforeEach(() => {
    resetElevenLabsCircuitBreakerForTests();
  });

  afterEach(() => {
    resetElevenLabsCircuitBreakerForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts disabled with ElevenLabs as preferred voice", () => {
    expect(getIsElevenLabsDisabled()).toBe(false);
    expect(getPreferredVoiceForCall("CA123")).toBe("ElevenLabs");
  });

  it("trips on auth failure and routes all calls to OpenAI", async () => {
    const { logger } = await import("../src/utils/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    markElevenLabsAuthFailure("CA123");

    expect(getIsElevenLabsDisabled()).toBe(true);
    expect(getPreferredVoiceForCall("CA456")).toBe("openai-tts-1-hd");
    expect(getConversationRelayTtsEngine()).toBe("Twilio ConversationRelay (OpenAI fallback)");
    expect(warnSpy).toHaveBeenCalledWith(ELEVENLABS_CIRCUIT_BREAKER_LOG);

    warnSpy.mockRestore();
  });

  it("logs the circuit breaker message once when tripped", async () => {
    const { logger } = await import("../src/utils/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    tripElevenLabsCircuitBreaker();
    tripElevenLabsCircuitBreaker();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(ELEVENLABS_CIRCUIT_BREAKER_LOG);

    warnSpy.mockRestore();
  });

  it("skips ElevenLabs fetch when circuit is open", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("quota", { status: 403 }),
    );

    tripElevenLabsCircuitBreaker();
    const result = await synthesizeSpeech("Hello there", "CA789");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();

    fetchSpy.mockRestore();
  });

  it("omits ElevenLabs ttsProvider from relay attrs when circuit is open", () => {
    tripElevenLabsCircuitBreaker();
    const attrs = buildConversationRelayVoiceAttrs();

    expect(attrs.ttsProvider).toBeUndefined();
    expect(attrs.voice).toBeTruthy();
    expect(attrs.voice).not.toBe("Google.en-US-Neural2-J");
  });
});
