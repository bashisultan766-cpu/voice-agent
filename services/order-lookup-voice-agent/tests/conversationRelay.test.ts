import { describe, expect, it } from "vitest";
import { conversationRelayVoice } from "../src/config.js";

describe("ConversationRelay TwiML voice", () => {
  it("builds Eric voice string for Twilio", () => {
    expect(conversationRelayVoice()).toMatch(/^cjVigY5qzO86Huf0OWal-turbo_v2_5/);
  });
});
