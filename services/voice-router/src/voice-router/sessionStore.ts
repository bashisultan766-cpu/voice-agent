import { getConfig, type AgentTarget } from "../config.js";

export interface RouteSession {
  callSid: string;
  target: AgentTarget;
  reason: string;
  lockedAt: number;
  speech?: string;
}

const sessions = new Map<string, RouteSession>();

function ttlMs(): number {
  return getConfig().SESSION_TTL_SECS * 1000;
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [sid, session] of sessions.entries()) {
    if (now - session.lockedAt > ttlMs()) {
      sessions.delete(sid);
    }
  }
}

export function getSession(callSid: string): RouteSession | null {
  purgeExpired();
  return sessions.get(callSid) ?? null;
}

export function lockSession(
  callSid: string,
  target: AgentTarget,
  reason: string,
  speech?: string,
): RouteSession {
  purgeExpired();
  const session: RouteSession = {
    callSid,
    target,
    reason,
    lockedAt: Date.now(),
    speech,
  };
  sessions.set(callSid, session);
  return session;
}

export function clearSession(callSid: string): void {
  sessions.delete(callSid);
}

export function clearAllSessions(): void {
  sessions.clear();
}

export function sessionCount(): number {
  purgeExpired();
  return sessions.size;
}
