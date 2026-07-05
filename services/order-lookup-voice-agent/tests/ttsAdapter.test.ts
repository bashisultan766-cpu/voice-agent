import { describe, expect, it } from "vitest";
import {
  AudioChunkAccumulator,
  MIN_AUDIO_CHUNK_BYTES,
  MAX_AUDIO_CHUNK_BYTES,
  normalizeAudioChunks,
  telephonyChunkBounds,
} from "../src/adapters/ttsAdapter.js";

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
