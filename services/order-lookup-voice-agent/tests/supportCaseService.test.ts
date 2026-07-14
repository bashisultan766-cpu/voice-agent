import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallSession } from "../src/types/order.js";
import { ensureSessionMemory } from "../src/agents/sessionMemory.js";

const { mockEmail, mockWebhook } = vi.hoisted(() => ({
  mockEmail: vi.fn(),
  mockWebhook: vi.fn(),
}));

vi.mock("../src/infra/supportEmailClient.js", () => ({
  sendSupportCaseEmail: mockEmail,
}));
vi.mock("../src/infra/supportWebhookClient.js", () => ({
  notifySupportCaseWebhook: mockWebhook,
}));

import { createCase, SupportCaseService } from "../src/agents/supportCaseService.js";

function session(): CallSession {
  return {
    callSid: "CA_SUPPORT_CASE",
    from: "+15551234567",
    to: "+15550000000",
    phase: "active",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    isVerifiedCaller: false,
  } as CallSession;
}

describe("SupportCaseService", () => {
  beforeEach(() => {
    mockEmail.mockReset();
    mockWebhook.mockReset();
    mockEmail.mockResolvedValue({ ok: true });
    mockWebhook.mockResolvedValue(true);
  });

  it("creates exactly one case then notifies", async () => {
    const s = session();
    const first = await createCase({
      session: s,
      reason: "warehouse_check",
      issueSummary: "Need title X",
      customerName: "Pat",
      callbackEmail: "pat@example.com",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const memory = ensureSessionMemory(s);
    expect(memory.supportCases).toHaveLength(1);
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(mockWebhook).toHaveBeenCalledTimes(1);

    const second = await createCase({
      session: s,
      reason: "warehouse_check",
      issueSummary: "Need title X",
      customerName: "Pat",
      callbackEmail: "pat@example.com",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.caseId).toBe(first.caseId);
    expect(memory.supportCases).toHaveLength(1);
  });

  it("notify failure does not create a second case", async () => {
    mockEmail.mockResolvedValueOnce({ ok: false, error: "resend down" });
    mockWebhook.mockResolvedValueOnce(false);
    const s = session();
    const result = await SupportCaseService.createCase({
      session: s,
      reason: "escalation",
      issueSummary: "Caller frustrated",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emailSent).toBe(false);
    expect(result.webhookNotified).toBe(false);
    expect(ensureSessionMemory(s).supportCases).toHaveLength(1);
  });

  it("sentiment module cannot fetch or email", () => {
    const src = readFileSync(join(__dirname, "..", "src", "utils", "sentiment.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/sendSupportEscalation/);
    expect(src).not.toMatch(/supportEmailClient/);
    expect(src).not.toMatch(/supportWebhookClient/);
  });
});

describe("SupportCaseService idempotency", () => {
  beforeEach(() => {
    mockEmail.mockReset();
    mockWebhook.mockReset();
    mockEmail.mockResolvedValue({ ok: true });
    mockWebhook.mockResolvedValue(true);
  });

  it("same requestId + same payload → single case (concurrent Promise.all)", async () => {
    const s = session();
    const requestId = "req_alpha";
    const req = {
      session: s,
      requestId,
      reason: "escalation",
      issueSummary: "Something went sideways",
    } as const;
    const [a, b, c] = await Promise.all([createCase(req), createCase(req), createCase(req)]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(new Set([a.caseId, b.caseId, c.caseId]).size).toBe(1);
    expect(ensureSessionMemory(s).supportCases).toHaveLength(1);
  });

  it("same requestId + conflicting payload → idempotency_conflict returns existing caseId", async () => {
    const s = session();
    const requestId = "req_conflict";
    const first = await createCase({
      session: s,
      requestId,
      reason: "escalation",
      issueSummary: "Original description",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await createCase({
      session: s,
      requestId,
      reason: "escalation",
      issueSummary: "TOTALLY DIFFERENT description",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("idempotency_conflict");
    expect(second.caseId).toBe(first.caseId);
    expect(ensureSessionMemory(s).supportCases).toHaveLength(1);
  });

  it("retry with same requestId re-invokes notify only for the failed leg", async () => {
    mockEmail.mockResolvedValueOnce({ ok: false, error: "temporary" });
    mockWebhook.mockResolvedValueOnce(true);
    const s = session();
    const requestId = "req_retry";
    const request = {
      session: s,
      requestId,
      reason: "escalation",
      issueSummary: "Retryable summary",
    } as const;
    const first = await createCase(request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.emailSent).toBe(false);
    expect(first.webhookNotified).toBe(true);
    mockEmail.mockResolvedValueOnce({ ok: true });
    const second = await createCase(request);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.caseId).toBe(first.caseId);
    expect(second.emailSent).toBe(true);
    expect(second.webhookNotified).toBe(true);
    expect(ensureSessionMemory(s).supportCases).toHaveLength(1);
    expect(mockEmail).toHaveBeenCalledTimes(2);
    expect(mockWebhook).toHaveBeenCalledTimes(1);
  });

  it("distinct requestIds create distinct cases even with similar summaries", async () => {
    const s = session();
    const a = await createCase({
      session: s,
      requestId: "req_A",
      reason: "escalation",
      issueSummary: "Refund inquiry",
    });
    const b = await createCase({
      session: s,
      requestId: "req_B",
      reason: "escalation",
      issueSummary: "Refund inquiry",
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.caseId).not.toBe(b.caseId);
    expect(ensureSessionMemory(s).supportCases).toHaveLength(2);
  });
});
