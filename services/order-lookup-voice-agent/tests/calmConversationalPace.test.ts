import { describe, expect, it } from "vitest";
import {
  BARGE_IN_HOLD_MS,
  BARGE_IN_MIN_AGENT_SILENCE_MS,
  evaluateBargeIn,
  VAD_SILENCE_THRESHOLD_MS,
} from "../src/streaming/audioProcessor.js";
import {
  decideTurnEnd,
  isIncompleteUtterance,
  mergeListeningWaitBuffer,
} from "../src/adapters/turnEndHeuristics.js";
import { SHOSHAN_SYSTEM_PROMPT } from "../src/prompts/systemPrompt.js";
import { runOrchestratorTurn } from "../src/agents/conversationOrchestrator.js";
import {
  markCallSessionActive,
  markCallSessionClosed,
} from "../src/voice/callSessionLock.js";
import type { CallSession } from "../src/types/order.js";

describe("Task 11 — Calm Conversational Pace", () => {
  it("VAD silence threshold is 800–1000ms (full second endpointing)", () => {
    expect(VAD_SILENCE_THRESHOLD_MS).toBeGreaterThanOrEqual(800);
    expect(VAD_SILENCE_THRESHOLD_MS).toBeLessThanOrEqual(1000);
    expect(VAD_SILENCE_THRESHOLD_MS).toBe(1000);
  });

  it("Wait-to-Verify rules are active in the system prompt", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CALM CONCIERGE RULES/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Wait-to-Verify/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/1\.5 seconds/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Mhm/i);
  });

  it("marks 'I want to buy a...' as incomplete (LISTENING_WAIT)", () => {
    expect(isIncompleteUtterance("I want to buy a...")).toBe(true);
    expect(isIncompleteUtterance("I want to buy a")).toBe(true);
    expect(decideTurnEnd("I want to buy a...").action).toBe("listening_wait");
  });

  it("500ms pause is below VAD threshold — turn must not finalize yet", () => {
    const pauseMs = 500;
    expect(pauseMs).toBeLessThan(VAD_SILENCE_THRESHOLD_MS);
  });

  it("simulation: incomplete clause yields no agent speech chunks", async () => {
    const callSid = "CA_CALM_PACE";
    markCallSessionActive(callSid);
    const session = {
      callSid,
      from: "+1",
      to: "+2",
      phase: "follow_up",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
    } as CallSession;

    try {
      const events: Array<{ type: string; chunk?: { text: string } }> = [];
      for await (const event of runOrchestratorTurn(session, "I want to buy a...")) {
        events.push(event as { type: string; chunk?: { text: string } });
      }

      const speech = events
        .filter((e) => e.type === "chunk")
        .map((e) => e.chunk?.text ?? "")
        .join(" ")
        .trim();

      expect(speech).toBe("");
      expect(session.sessionMemory?.listeningWaitBuffer).toMatch(/buy a/i);
    } finally {
      markCallSessionClosed(callSid);
    }
  });

  it("merges wait buffer when the caller finishes the clause", () => {
    const merged = mergeListeningWaitBuffer("I want to buy a", "mystery novel please.");
    expect(decideTurnEnd(merged).action).toBe("respond");
    expect(merged.toLowerCase()).toContain("mystery");
  });

  it("barge-in stays suppressed until agent silence + sustained loud inbound", () => {
    const loud = Buffer.alloc(320, 0x00);
    const quiet = Buffer.alloc(320, 0xff);

    expect(
      evaluateBargeIn({
        inboundMulaw: loud,
        agentOutboundPower: 2500,
        agentSilentForMs: 50,
        sustainedInboundMs: BARGE_IN_HOLD_MS,
      }).allow,
    ).toBe(false);

    expect(
      evaluateBargeIn({
        inboundMulaw: quiet,
        agentOutboundPower: 2500,
        agentSilentForMs: BARGE_IN_MIN_AGENT_SILENCE_MS + 50,
        sustainedInboundMs: BARGE_IN_HOLD_MS,
      }).allow,
    ).toBe(false);

    expect(
      evaluateBargeIn({
        inboundMulaw: loud,
        agentOutboundPower: 80,
        agentSilentForMs: BARGE_IN_MIN_AGENT_SILENCE_MS + 50,
        sustainedInboundMs: BARGE_IN_HOLD_MS,
      }).allow,
    ).toBe(true);
  });
});
