import { describe, expect, it, beforeEach } from "vitest";
import type { CallSession } from "../src/types/order.js";
import { ensureSessionMemory } from "../src/agents/sessionMemory.js";
import {
  buildDictationMetadata,
  hydrateSessionMemory,
  syncSessionMemory,
} from "../src/agents/sessionStateService.js";
import {
  clearActiveSession,
  clearAllActiveSessions,
  createActiveSession,
  getOrCreateActiveSession,
  recordTrackingPayload,
  updateActiveSession,
} from "../src/sovereign/activeSession.js";
import {
  clearAllUnifiedSessions,
  registerUnifiedSession,
  getUnifiedSession,
} from "../src/agents/unifiedCallSession.js";

function makeSession(callSid: string): CallSession {
  const session: CallSession = {
    callSid,
    from: "+15551234567",
    to: "+15557654321",
    phase: "active",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    sessionMemory: { initialIntent: null, pendingGoal: null },
  };
  registerUnifiedSession(session);
  createActiveSession(callSid);
  return session;
}

describe("SessionStateService dictation durability", () => {
  beforeEach(() => {
    clearAllUnifiedSessions();
    clearAllActiveSessions();
  });

  it("syncSessionMemory writes tracking + spatial_index into sessionMemory.metadata", () => {
    const session = makeSession("CA_SYNC_META");
    recordTrackingPayload(session.callSid, "9400111899223344556677");
    syncSessionMemory(session.callSid);

    const meta = ensureSessionMemory(session).metadata;
    expect(meta?.tracking_number).toBeTruthy();
    expect(meta?.tracking_number_for_tts).toBeTruthy();
    expect(meta?.spatial_index?.length).toBeGreaterThan(0);
    expect(meta?.is_tracking_in_progress).toBe(true);
    expect(meta?.current_state).toBe("awaiting_notepad_ready");
  });

  it("hydrateSessionMemory restores ActiveSession after Map wipe", () => {
    const session = makeSession("CA_HYDRATE_META");
    recordTrackingPayload(session.callSid, "9400111899223344556677");
    updateActiveSession(session.callSid, {
      isNotepadReady: true,
      currentState: "tracking_dictation",
      lastSpokenIndex: 5,
    });
    syncSessionMemory(session.callSid);

    // Simulate process restart — empty ActiveSession Map, keep CallSession L1/L2 blob.
    clearActiveSession(session.callSid);
    createActiveSession(session.callSid);

    const restored = hydrateSessionMemory(session.callSid, session);
    expect(restored.spatialIndex.length).toBeGreaterThan(0);
    expect(restored.lastSpokenPayload?.trackingForTts).toBeTruthy();
    expect(restored.lastSpokenIndex).toBe(5);
    expect(restored.currentState).toBe("tracking_dictation");
    expect(restored.isNotepadReady).toBe(true);
    expect(restored.cachedIntent).toBe("tracking");
  });

  it("hydrate with missing metadata initializes empty state", () => {
    const session = makeSession("CA_EMPTY_META");
    const active = hydrateSessionMemory(session.callSid, session);
    expect(active.spatialIndex).toEqual([]);
    expect(active.lastSpokenPayload).toBeNull();
    expect(active.currentState).toBe("idle");
  });

  it("buildDictationMetadata marks is_tracking_in_progress during notepad wait", () => {
    const session = makeSession("CA_BUILD_META");
    recordTrackingPayload(session.callSid, "1Z999AA10123456784");
    const meta = buildDictationMetadata(getOrCreateActiveSession(session.callSid));
    expect(meta.is_tracking_in_progress).toBe(true);
    expect(meta.tracking_number_for_tts).toBeTruthy();
    expect(getUnifiedSession(session.callSid)?.callSid).toBe(session.callSid);
  });
});
