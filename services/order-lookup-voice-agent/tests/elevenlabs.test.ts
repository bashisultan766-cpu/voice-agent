import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSpeechText, synthesizeSpeech } from "../src/voice/tts/elevenlabs.js";

describe("elevenlabs TTS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("prepares speech text with natural pauses", () => {
    const text = prepareSpeechText("Hello — how are you?");
    expect(text).toContain("...");
    expect(text).not.toContain("—");
  });

  it("calls ElevenLabs text-to-speech API directly", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "audio/mpeg" },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesizeSpeech("Hello there.");
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.contentType).toBe("audio/mpeg");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/text-to-speech/");
    expect(url).not.toContain("/stream");
    expect((options.headers as Record<string, string>)["xi-api-key"]).toBeTruthy();
  });
});
