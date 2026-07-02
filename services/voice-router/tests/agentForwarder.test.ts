import { beforeEach, describe, expect, it, vi } from "vitest";
import { forwardToAgent, isOrderLookupHealthy } from "../src/voice-router/agentForwarder.js";
import { clearAllSessions } from "../src/voice-router/sessionStore.js";

describe("agentForwarder", () => {
  beforeEach(() => {
    clearAllSessions();
    vi.restoreAllMocks();
  });

  it("falls back to main agent when order lookup health check fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/health")) {
          return { ok: false } as Response;
        }
        if (url.includes("8001")) {
          return {
            ok: true,
            text: async () => '<?xml version="1.0"?><Response></Response>',
          } as Response;
        }
        throw new Error("should not hit order lookup inbound");
      }),
    );

    const result = await forwardToAgent(
      "order_lookup",
      { CallSid: "CA999", From: "+15550001" },
      { callSid: "CA999", reason: "test" },
    );

    expect(result.fallbackUsed).toBe(true);
    expect(result.target).toBe("main_agent");
  });

  it("reports order lookup healthy when health endpoint returns ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true }),
      })) as typeof fetch,
    );

    await expect(isOrderLookupHealthy()).resolves.toBe(true);
  });
});
