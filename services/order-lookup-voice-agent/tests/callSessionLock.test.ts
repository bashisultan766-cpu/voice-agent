import { beforeEach, describe, expect, it } from "vitest";
import {
  beginCallTurn,
  clearAllCallEventSessions,
  dispatchAgentEvent,
} from "../src/platform/eventDispatcher.js";
import {
  appendToPostgresAsync,
  initPostgresEventStore,
  isPostgresDisabled,
  resetPostgresEventStoreState,
} from "../src/platform/postgresEventStore.js";
import {
  clearAllCallSessionLocks,
  isCallSessionActive,
  markCallSessionActive,
  markCallSessionClosed,
} from "../src/voice/callSessionLock.js";

describe("callSessionLock", () => {
  const callSid = "CA_lock_test";

  beforeEach(() => {
    clearAllCallEventSessions();
    clearAllCallSessionLocks();
  });

  it("tracks active vs closed calls", () => {
    markCallSessionActive(callSid);
    expect(isCallSessionActive(callSid)).toBe(true);
    markCallSessionClosed(callSid);
    expect(isCallSessionActive(callSid)).toBe(false);
  });

  it("suppresses dispatch after hangup without turn_seq warning", () => {
    markCallSessionActive(callSid);
    beginCallTurn(callSid);
    markCallSessionClosed(callSid);

    const result = dispatchAgentEvent(callSid, {
      type: "RESPONSE_SENT",
      payload: { responseType: "test", speechLength: 0 },
    });

    expect(result).toBeNull();
  });
});

describe("postgresEventStore silencer", () => {
  beforeEach(() => {
    resetPostgresEventStoreState();
    delete process.env.DATABASE_URL;
  });

  it("sets POSTGRES_DISABLED when DATABASE_URL is unset", async () => {
    const ok = await initPostgresEventStore();
    expect(ok).toBe(false);
    expect(isPostgresDisabled()).toBe(true);

    expect(() =>
      appendToPostgresAsync({
        id: "evt_1",
        callSid: "CA_pg",
        turnSeq: 1,
        eventType: "TURN_INGESTED",
        eventVersion: 1,
        payload: { textLength: 0 },
        memoryBefore: null,
        memoryAfter: null,
        latencyMs: null,
        createdAt: Date.now(),
      }),
    ).not.toThrow();
  });
});
