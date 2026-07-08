import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  AudioChunkAccumulator,
  MIN_AUDIO_CHUNK_BYTES,
  MAX_AUDIO_CHUNK_BYTES,
  normalizeAudioChunks,
  telephonyChunkBounds,
} from "../src/adapters/ttsAdapter.js";

const baseEnv = {
  PUBLIC_BASE_URL: "https://example.com",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "secret",
  OPENAI_API_KEY: "sk-test",
  SHOPIFY_SHOP_DOMAIN: "shop.myshopify.com",
  SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat",
  VOICE_TTS_PROVIDER: "ElevenLabs",
  VOICE_IDENTITY_CONSTRAINT: "false",
  ELEVENLABS_API_KEY: "el-test-key",
  VOICE_ID: "voice123",
};

function mockElevenLabsProbe(ok: boolean, status = ok ? 200 : 403): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("api.elevenlabs.io/v1/user")) {
        return new Response(ok ? "{}" : "quota", { status });
      }
      if (String(url).includes("text-to-speech")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: ok ? 200 : status,
          headers: { "content-type": "audio/basic" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

async function loadVoiceStack() {
  const config = await import("../src/config.js");
  config.resetConfigCacheForTests();
  return import("../src/adapters/voiceAdapter.js");
}

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

describe("static global voice provider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, ...baseEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("selects ElevenLabs once at boot when probe succeeds", async () => {
    mockElevenLabsProbe(true);
    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();

    const provider = await voice.initializeGlobalVoiceProvider();
    expect(provider).toBe("ElevenLabs");
    expect(voice.getGlobalVoiceProvider()).toBe("ElevenLabs");
    expect(voice.getPreferredVoiceForCall("CA123")).toBe("ElevenLabs");
    expect(voice.getMediaStreamTtsEngine()).toBe("Media Streams (ElevenLabs)");
  });

  it("permanently locks OpenAI when ElevenLabs auth probe fails", async () => {
    const { logger } = await import("../src/utils/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    mockElevenLabsProbe(false, 403);
    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();

    const provider = await voice.initializeGlobalVoiceProvider();

    expect(provider).toBe("OpenAI");
    expect(voice.getIsElevenLabsDisabled()).toBe(true);
    expect(voice.getPreferredVoiceForCall("CA456")).toBe("openai-tts-1-hd");
    expect(voice.getMediaStreamTtsEngine()).toBe("Media Streams (OpenAI fallback)");
    expect(voice.getElevenLabsCircuitSnapshot().failoverReason).toBe("auth_failed");
    expect(warnSpy).toHaveBeenCalledWith(
      voice.ELEVENLABS_CIRCUIT_BREAKER_LOG,
      expect.objectContaining({ reason: "auth_failed" }),
    );

    warnSpy.mockRestore();
  });

  it("permanently locks OpenAI when ElevenLabs quota probe returns 429", async () => {
    mockElevenLabsProbe(false, 429);
    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();

    const provider = await voice.initializeGlobalVoiceProvider();

    expect(provider).toBe("OpenAI");
    expect(voice.getElevenLabsCircuitSnapshot()).toMatchObject({
      open: true,
      failoverReason: "quota_exceeded",
      lastHttpStatus: 429,
    });
  });

  it("permanently locks OpenAI when ElevenLabs probe returns 5xx", async () => {
    mockElevenLabsProbe(false, 503);
    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();

    const provider = await voice.initializeGlobalVoiceProvider();

    expect(provider).toBe("OpenAI");
    expect(voice.getElevenLabsCircuitSnapshot()).toMatchObject({
      open: true,
      failoverReason: "server_error",
      lastHttpStatus: 503,
    });
  });

  it("classifies HTTP status codes for circuit trips", async () => {
    const voice = await loadVoiceStack();
    expect(voice.classifyElevenLabsHttpStatus(401)).toBe("auth_failed");
    expect(voice.classifyElevenLabsHttpStatus(429)).toBe("quota_exceeded");
    expect(voice.classifyElevenLabsHttpStatus(500)).toBe("server_error");
    expect(voice.classifyElevenLabsHttpStatus(404)).toBe("probe_http_error");
  });

  it("trips circuit on runtime 503 TTS response", async () => {
    mockElevenLabsProbe(true);
    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();
    await voice.initializeGlobalVoiceProvider();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("text-to-speech")) {
          return new Response("unavailable", { status: 503 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const tts = await import("../src/adapters/ttsAdapter.js");
    await tts.synthesizeSpeech("Hello there", "CA503");

    expect(voice.getIsElevenLabsDisabled()).toBe(true);
    expect(voice.getElevenLabsCircuitSnapshot().failoverReason).toBe("server_error");
  });

  it("does not re-probe ElevenLabs on subsequent init calls", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();

    await voice.initializeGlobalVoiceProvider();
    await voice.initializeGlobalVoiceProvider();

    const probeCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes("api.elevenlabs.io/v1/user"),
    );
    expect(probeCalls).toHaveLength(1);
  });

  it("trips runtime auth failure without retrying ElevenLabs", async () => {
    mockElevenLabsProbe(true);
    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();
    await voice.initializeGlobalVoiceProvider();

    const tts = await import("../src/adapters/ttsAdapter.js");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    voice.markElevenLabsAuthFailure("CA123");
    expect(voice.getIsElevenLabsDisabled()).toBe(true);

    await tts.synthesizeSpeech("Hello there", "CA789");
    expect(
      fetchSpy.mock.calls.some((call) => String(call[0]).includes("elevenlabs.io")),
    ).toBe(false);

    fetchSpy.mockRestore();
  });

  it("locks OpenAI Eric fallback voice when ElevenLabs auth probe fails", async () => {
    mockElevenLabsProbe(false, 401);
    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();
    await voice.initializeGlobalVoiceProvider();

    expect(voice.getOpenAiEricFallbackVoice()).toBeTruthy();
    expect(voice.getPreferredVoiceForCall("CA999")).toBe("openai-tts-1-hd");
  });

  it("logs circuit breaker only once when tripped repeatedly", async () => {
    const { logger } = await import("../src/utils/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();

    voice.tripElevenLabsCircuitBreaker();
    voice.tripElevenLabsCircuitBreaker();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(voice.ELEVENLABS_CIRCUIT_BREAKER_LOG);

    warnSpy.mockRestore();
  });
});

describe("voice identity constraint", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ...baseEnv,
      VOICE_IDENTITY_CONSTRAINT: "true",
    };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("locks OpenAI without ElevenLabs probe or failure logs", async () => {
    const { logger } = await import("../src/utils/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();

    const provider = await voice.initializeGlobalVoiceProvider();

    expect(provider).toBe("OpenAI");
    expect(voice.getHealthVoiceProviderLabel()).toBe(
      "OpenAI (Identity Constraint Active)",
    );
    expect(voice.getElevenLabsCircuitSnapshot()).toMatchObject({
      open: true,
      failoverReason: "identity_constraint",
      lastHttpStatus: null,
    });
    expect(
      fetchSpy.mock.calls.some((call) => String(call[0]).includes("elevenlabs.io")),
    ).toBe(false);
    expect(
      warnSpy.mock.calls.some(
        (call) => call[0] === "elevenlabs_failure_recorded",
      ),
    ).toBe(false);
    expect(
      warnSpy.mock.calls.some(
        (call) => call[0] === voice.ELEVENLABS_CIRCUIT_BREAKER_LOG,
      ),
    ).toBe(false);

    warnSpy.mockRestore();
  });

  it("routes TTS through OpenAI only when constraint is active", async () => {
    const fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    const voice = await loadVoiceStack();
    voice.resetElevenLabsCircuitBreakerForTests();
    await voice.initializeGlobalVoiceProvider();

    const tts = await import("../src/adapters/ttsAdapter.js");
    await tts.synthesizeSpeech("Hello there", "CA-constraint");

    expect(
      fetchSpy.mock.calls.some((call) => String(call[0]).includes("elevenlabs.io")),
    ).toBe(false);
  });
});
