import { beforeEach, describe, expect, it } from "vitest";
import { getSession, lockSession, clearAllSessions } from "../src/voice-router/sessionStore.js";

describe("sessionStore", () => {
  beforeEach(() => {
    clearAllSessions();
  });

  it("locks one agent per callSid", () => {
    lockSession("CA123", "order_lookup", "order_number_pattern", "456789");
    const session = getSession("CA123");
    expect(session?.target).toBe("order_lookup");
    expect(session?.speech).toBe("456789");
  });

  it("prevents double assignment until cleared", () => {
    lockSession("CA123", "order_lookup", "first");
    lockSession("CA123", "main_agent", "second");
    expect(getSession("CA123")?.target).toBe("main_agent");
  });
});
