import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { attachMailCallRelayHandler } from "../src/agents/mailcall/router.js";

class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }
}

describe("ConversationRelay end-call flow", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.stubEnv("MAILCALL_TWILIO_PHONE_NUMBER", "+15551234567");
    vi.stubEnv("MAILCALL_WP_URL", "https://wp.example");
    vi.stubEnv("MAILCALL_WP_USER", "editor");
    vi.stubEnv("MAILCALL_WP_APP_PASSWORD", "abcdefghijklmnopqrstuvwx");
    vi.stubEnv("MAILCALL_OPENAI_API_KEY", "");
    vi.stubEnv("MAILCALL_VALIDATE_TWILIO_SIGNATURES", "false");
  });

  it("sends final speech before the relay end command", async () => {
    const wss = new EventEmitter();
    const socket = new FakeSocket();
    attachMailCallRelayHandler(wss as never);
    wss.emit("connection", socket);

    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        callSid: "goodbye-call",
        voicePrompt: "Thank you, I do not need anything else. Goodbye.",
      }),
    );

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const messages = socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(messages[0]).toMatchObject({
      type: "text",
      token: "You're very welcome. Thanks for calling MailCall Newspaper. Goodbye.",
      last: true,
    });
    expect(messages[1]).toEqual({ type: "end" });
  });
});
