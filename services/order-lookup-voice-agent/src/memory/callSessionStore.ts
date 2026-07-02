/**
 * Persists CallSession across Twilio HTTP round-trips (Gather/Play loop).
 */
import { createCallSession } from "../agents/conversationBrain.js";
import type { CallSession } from "../types/order.js";

const TTL_MS = 60 * 60 * 1000;
const sessions = new Map<string, CallSession>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [sid, session] of sessions.entries()) {
    if (now - session.createdAt > TTL_MS) {
      sessions.delete(sid);
    }
  }
}

export function getOrCreateCallSession(
  callSid: string,
  from: string,
  to: string,
): CallSession {
  purgeExpired();
  const existing = sessions.get(callSid);
  if (existing) return existing;

  const session = createCallSession(callSid, from, to);
  session.phase = "awaiting_order_number";
  sessions.set(callSid, session);
  return session;
}

export function getCallSession(callSid: string): CallSession | undefined {
  purgeExpired();
  return sessions.get(callSid);
}

export function saveCallSession(session: CallSession): void {
  sessions.set(session.callSid, session);
}

export function clearCallSession(callSid: string): void {
  sessions.delete(callSid);
}

export function clearAllCallSessions(): void {
  sessions.clear();
}

/** Test helper */
export function callSessionCount(): number {
  purgeExpired();
  return sessions.size;
}
