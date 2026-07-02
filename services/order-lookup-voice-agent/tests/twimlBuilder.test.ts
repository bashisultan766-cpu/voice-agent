import { describe, expect, it } from "vitest";
import {
  buildGreetingTwiml,
  buildHangupTwiml,
  buildPlayGatherTwiml,
} from "../src/voice/twimlBuilder.js";

describe("twimlBuilder", () => {
  it("builds Play + Gather without Twilio Say", () => {
    const twiml = buildPlayGatherTwiml(["https://example.com/voice/twilio/audio/abc.mp3"]);
    expect(twiml).toContain("<Play>https://example.com/voice/twilio/audio/abc.mp3</Play>");
    expect(twiml).toContain('<Gather input="speech"');
    expect(twiml).toContain("/voice/twilio/turn");
    expect(twiml).not.toContain("<Say");
    expect(twiml).not.toContain("ConversationRelay");
  });

  it("builds greeting Gather with Play inside", () => {
    const twiml = buildGreetingTwiml("https://example.com/greet.mp3");
    expect(twiml).toContain("<Gather");
    expect(twiml).toContain("<Play>https://example.com/greet.mp3</Play>");
    expect(twiml).not.toContain("<Say");
  });

  it("builds hangup after Play", () => {
    const twiml = buildHangupTwiml(["https://example.com/goodbye.mp3"]);
    expect(twiml).toContain("<Play>https://example.com/goodbye.mp3</Play>");
    expect(twiml).toContain("<Hangup/>");
    expect(twiml).not.toContain("<Say");
  });
});
