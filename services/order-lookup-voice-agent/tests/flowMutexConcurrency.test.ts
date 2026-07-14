import { describe, expect, it, vi } from "vitest";
import {
  acquireFlowMutex,
  assertLeaseValid,
  getFlowMutex,
  releaseFlowMutex,
  renewFlowMutex,
  withFlowMutex,
  CHECKOUT_MUTEX_TTL_MS,
} from "../src/agents/flowMutex.js";
import { ensureSessionMemory } from "../src/agents/sessionMemory.js";
import type { CallSession } from "../src/types/order.js";

function session(id = "CA_MUTEX"): CallSession {
  return { callSid: id } as CallSession;
}

describe("FlowMutex concurrency", () => {
  it("does not release a newer lease with a wrong/stale token", () => {
    const s = session();
    const first = acquireFlowMutex(s, "checkout");
    const second = acquireFlowMutex(s, "checkout");
    releaseFlowMutex(s, first.leaseToken);
    expect(() => assertLeaseValid(s, second.leaseToken)).not.toThrow();
    expect(getFlowMutex(s).owner).toBe("checkout");
  });

  it("marks previous owner stale after reacquire", () => {
    const s = session("CA_STALE");
    const first = acquireFlowMutex(s, "checkout", "first");
    const second = acquireFlowMutex(s, "support", "second");
    expect(() => assertLeaseValid(s, first.leaseToken)).toThrow(/FLOW_MUTEX_LEASE_INVALID/);
    expect(() => assertLeaseValid(s, second.leaseToken)).not.toThrow();
  });

  it("renewal succeeds for current lease and fails for stale token", () => {
    const s = session("CA_RENEW");
    const lease = acquireFlowMutex(s, "checkout");
    expect(renewFlowMutex(s, lease.leaseToken)).toBe(true);
    expect(renewFlowMutex(s, "dead-token")).toBe(false);
  });

  it("increments stateVersion on each acquire (stale write version)", () => {
    const s = session("CA_VER");
    const a = acquireFlowMutex(s, "checkout");
    const v1 = getFlowMutex(s).stateVersion ?? 0;
    acquireFlowMutex(s, "checkout");
    const v2 = getFlowMutex(s).stateVersion ?? 0;
    expect(v2).toBeGreaterThan(v1);
    expect(() => assertLeaseValid(s, a.leaseToken)).toThrow();
  });

  it("dual acquire: only the latest lease can commit", () => {
    const s = session("CA_DUAL");
    const a = acquireFlowMutex(s, "checkout");
    const b = acquireFlowMutex(s, "checkout");
    expect(() => assertLeaseValid(s, a.leaseToken)).toThrow();
    expect(() => assertLeaseValid(s, b.leaseToken)).not.toThrow();
  });

  it("release is idempotent for the active token", () => {
    const s = session("CA_IDEM");
    const lease = acquireFlowMutex(s, "checkout");
    releaseFlowMutex(s, lease.leaseToken);
    releaseFlowMutex(s, lease.leaseToken);
    expect(getFlowMutex(s).owner).toBe("none");
  });

  it("expires leases by TTL and allows a new owner", () => {
    const s = session("CA_TTL");
    acquireFlowMutex(s, "sentiment_escalation", "shield");
    const m = ensureSessionMemory(s).flowMutex!;
    m.expiresAt = Date.now() - 1;
    expect(getFlowMutex(s).owner).toBe("none");
    const next = acquireFlowMutex(s, "checkout");
    expect(getFlowMutex(s).owner).toBe("checkout");
    expect(next.leaseToken).toBeTruthy();
  });

  it("renewal during long op keeps lease alive", async () => {
    const s = session("CA_LONG");
    await withFlowMutex(s, "checkout", "long", async (lease) => {
      const before = getFlowMutex(s).expiresAt;
      expect(renewFlowMutex(s, lease.leaseToken)).toBe(true);
      expect(getFlowMutex(s).expiresAt).toBeGreaterThanOrEqual(before);
      expect(() => assertLeaseValid(s, lease.leaseToken)).not.toThrow();
    });
    expect(getFlowMutex(s).owner).toBe("none");
  });

  it("restart via TTL: expired op cannot commit after new owner", () => {
    const s = session("CA_RESTART");
    const old = acquireFlowMutex(s, "checkout", "old");
    const bucket = ensureSessionMemory(s).flowMutex!;
    bucket.expiresAt = Date.now() - 5;
    const neu = acquireFlowMutex(s, "checkout", "new");
    expect(() => assertLeaseValid(s, old.leaseToken)).toThrow();
    expect(() => assertLeaseValid(s, neu.leaseToken)).not.toThrow();
    expect(CHECKOUT_MUTEX_TTL_MS).toBeGreaterThan(0);
  });
});
