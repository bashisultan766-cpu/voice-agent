import { describe, expect, it } from "vitest";

import {
  buildComfortNoisePacket,
  MULAW_SILENCE_BYTE,
  pcm16leToMulaw,
  pcm16leToMulaw8k,
  resamplePcm16le,
} from "../src/utils/telephonyAudio.js";

describe("telephonyAudio", () => {
  it("encodes PCM silence to μ-law silence byte", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(0, 0);
    pcm.writeInt16LE(0, 2);
    const mulaw = pcm16leToMulaw(pcm);
    expect(mulaw[0]).toBe(MULAW_SILENCE_BYTE);
  });

  it("downsamples 24 kHz PCM to 8 kHz before μ-law encoding", () => {
    const pcm24 = Buffer.alloc(24 * 2);
    for (let i = 0; i < 24; i++) {
      pcm24.writeInt16LE(i % 2 === 0 ? 2000 : -2000, i * 2);
    }
    const at8k = resamplePcm16le(pcm24, 24_000, 8_000);
    expect(at8k.length / 2).toBe(8);
    const mulaw = pcm16leToMulaw8k(pcm24);
    expect(mulaw.length).toBe(8);
  });

  it("builds comfort-noise packets for stream heartbeat", () => {
    const packet = buildComfortNoisePacket(160);
    expect(packet.length).toBe(160);
    expect(packet.every((b) => b === MULAW_SILENCE_BYTE)).toBe(true);
  });
});
