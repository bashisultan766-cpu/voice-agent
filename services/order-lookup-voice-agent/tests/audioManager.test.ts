import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { clearAudioIndex, getAudioFile, saveAudio } from "../src/audio/audioManager.js";

describe("audioManager", () => {
  afterEach(async () => {
    clearAudioIndex();
    vi.resetModules();
  });

  it("saves MP3 and returns a public Play URL", async () => {
    const stored = await saveAudio(Buffer.from("fake-mp3"), "CA_TEST");
    expect(stored.url).toMatch(/\/voice\/twilio\/audio\/.*\.mp3$/);
    expect(stored.id).toBeTruthy();

    const audio = await getAudioFile(stored.id);
    expect(audio?.toString()).toBe("fake-mp3");
  });

  it("reads audio from disk when not in memory index", async () => {
    const stored = await saveAudio(Buffer.from("disk-mp3"), "CA_DISK");
    clearAudioIndex();

    const audio = await getAudioFile(stored.id);
    expect(audio?.toString()).toBe("disk-mp3");

    await fs.unlink(stored.filePath).catch(() => undefined);
  });
});
