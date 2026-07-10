import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { withCallSessionLock, clearCallSessionLocks } from "../src/platform/sessionLock.js";
import {
  resetSessionPersistenceState,
  isSessionPersistenceEnabled,
} from "../src/platform/sessionPersistence.js";
import {
  createCallSession,
  createOrHydrateCallSession,
  endCallSession,
} from "../src/agents/conversationOrchestrator.js";
import {
  getUnifiedSession,
  clearAllUnifiedSessions,
  applyUnifiedWorkflowTransition,
} from "../src/agents/unifiedCallSession.js";
import { resetPostgresEventStoreState } from "../src/platform/postgresEventStore.js";

describe("sessionLock", () => {
  beforeEach(() => {
    clearCallSessionLocks();
  });

  it("serializes concurrent mutations for the same callSid", async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      withCallSessionLock("CA_LOCK", async () => {
        order.push(n);
        await new Promise((r) => setTimeout(r, 5));
        order.push(n * 10);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it("allows parallel work across different callSids", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = (sid: string) =>
      withCallSessionLock(sid, async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 15));
        concurrent -= 1;
      });
    await Promise.all([run("CA_A"), run("CA_B")]);
    expect(maxConcurrent).toBe(2);
  });
});

describe("session persistence wrapper (Priority 5)", () => {
  const callSid = "CA_PERSIST_TEST";

  beforeEach(() => {
    endCallSession(callSid);
    clearAllUnifiedSessions();
    resetSessionPersistenceState();
    resetPostgresEventStoreState();
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    endCallSession(callSid);
    clearAllUnifiedSessions();
    resetSessionPersistenceState();
  });

  it("stays L1-only when Postgres is disabled (tests / local)", () => {
    expect(isSessionPersistenceEnabled()).toBe(false);
    const session = createCallSession(callSid, "+15551110000", "+15552220000");
    expect(getUnifiedSession(callSid)).toBe(session);
    applyUnifiedWorkflowTransition(session, "product_search", { reason: "test" });
    expect(session.flowMode).toBe("PURCHASE_FLOW");
  });

  it("createOrHydrate returns the same L1 session without DB", async () => {
    const first = createCallSession(callSid, "+15551110000", "+15552220000");
    const second = await createOrHydrateCallSession(callSid, "+15551110000", "+15552220000");
    expect(second).toBe(first);
  });

  it("endCallSession clears L1 registry (archive is no-op without DB)", () => {
    const session = createCallSession(callSid, "+15551110000", "+15552220000");
    endCallSession(callSid, session);
    expect(getUnifiedSession(callSid)).toBeUndefined();
  });
});
