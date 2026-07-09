import { beforeEach, describe, expect, it, vi } from "vitest";
import { runOrchestratorTurn } from "../src/agents/conversationOrchestrator.js";
import { createCallSession } from "../src/agents/orderAgent.js";
import { applyCallerVerificationFromOrder } from "../src/agents/callerVerification.js";
import {
  armPrivateInfoBlockedEscalation,
  getSupportEscalationState,
  getSupportEscalationEmailState,
  resolveSupportEscalationTurn,
} from "../src/agents/supportEscalationFlow.js";
import { resolveEmailConfirmationTurn } from "../src/agents/emailConfirmationManager.js";
import {
  buildEmailConfirmationSpeech,
  extractEmailFromSpeech,
  normalizeSpokenEmail,
  spellEmailHyphenForTTS,
} from "../src/utils/emailCapture.js";
import { saveActiveOrderContext } from "../src/agents/sessionManager.js";
import { clearAllConversationFlowModes } from "../src/agents/conversationFlowState.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";
import { clearAllCallStates } from "../src/memory/callStateStore.js";
import { clearAllCallEventSessions } from "../src/platform/eventDispatcher.js";
import { clearAllTurnQueues } from "../src/runtime/turnExecutionQueue.js";
import { clearAllStreamBarriers } from "../src/runtime/streamTurnBarrier.js";
import { clearAllTurnHealth } from "../src/runtime/turnHealthMonitor.js";
import { resetPipelineGuard, enablePipelineGuardForTests } from "../src/guards/pipelineGuard.js";
import { resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import { resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";
import { setLlmAgentTurnOverride } from "../src/adapters/openaiAdapter.js";
import { defaultTestLlmAgentTurn } from "./helpers/llmAgentMock.js";
import * as resendEmailService from "../src/utils/resendEmailService.js";
import type { CallSession } from "../src/types/order.js";

async function collectSpeech(session: CallSession, text: string): Promise<string> {
  const parts: string[] = [];
  for await (const event of runOrchestratorTurn(session, text)) {
    if (event.type === "chunk") parts.push(event.chunk.text);
  }
  return parts.join(" ");
}

function seedUnverifiedOrderSession(callSid: string): CallSession {
  const session = createCallSession(callSid, "+15550001111", "+18005551212");
  session.greetedThisCall = true;
  session.phase = "follow_up";
  applyCallerVerificationFromOrder(session, {
    status: "found",
    orderNumber: "21698",
    customerName: "Jane Doe",
    customerPhone: "+15551234567",
    customerId: "gid://shopify/Customer/12345",
    totalOrderCount: 10,
  } as any);
  saveActiveOrderContext(session, {
    order_number: "21698",
    customer_name: "Jane Doe",
    tracking_number: "1Z999AA10123456784",
    fulfillment_status: "fulfilled",
  });
  return session;
}

describe("emailCapture", () => {
  it("normalizes spoken email with number words", () => {
    expect(normalizeSpokenEmail("Bashi Sahab sixty four at gmail dot com")).toBe(
      "bashisahab64@gmail.com",
    );
  });

  it("spells email with hyphens for confirmation", () => {
    expect(spellEmailHyphenForTTS("bashisahab64@gmail.com")).toMatch(
      /B-A-S-H-I-S-A-H-A-B-6-4 at gmail dot com/i,
    );
  });
});

describe("support escalation flow", () => {
  beforeEach(() => {
    clearAllCallMemories();
    clearAllCallStates();
    clearAllCallEventSessions();
    clearAllTurnQueues();
    clearAllStreamBarriers();
    clearAllTurnHealth();
    clearAllConversationFlowModes();
    resetPipelineGuard();
    enablePipelineGuardForTests(true);
    resetToolExecutionGuard();
    resetToolAccessGuard();
    setLlmAgentTurnOverride(defaultTestLlmAgentTurn);
    vi.restoreAllMocks();
  });

  it("1 — non-verified order history refusal offers support escalation", async () => {
    const session = seedUnverifiedOrderSession("CA_ESC_1");
    const speech = await collectSpeech(session, "tell me my previous order history");
    expect(speech).toMatch(/10 previous orders/i);
    expect(speech).toMatch(/forward your request to our support team/i);
    expect(getSupportEscalationState(session)).toBe("non_verified_private_info_blocked");
  });

  it("2 — yes forward to support asks for caller email", async () => {
    const session = seedUnverifiedOrderSession("CA_ESC_2");
    await collectSpeech(session, "what is the shipping address");
    const speech = await collectSpeech(session, "yes, forward it to support");
    expect(getSupportEscalationEmailState(session)).toBe("support_escalation_pending_email");
    expect(speech).toMatch(/email address should we use|support team/i);
    expect(speech).not.toMatch(/tracking/i);
  });

  it("3 — email response repeats spelling and asks confirmation", async () => {
    const session = seedUnverifiedOrderSession("CA_ESC_3");
    await collectSpeech(session, "tell me all order details");
    await collectSpeech(session, "yes please forward to support");
    const speech = await collectSpeech(
      session,
      "Bashi Sahab sixty four at gmail dot com",
    );
    expect(getSupportEscalationEmailState(session)).toBe(
      "support_escalation_pending_email_confirmation",
    );
    expect(speech).toMatch(/bashisahab64|B-A-S-H/i);
    expect(speech).toMatch(/Is that correct/i);
    expect(speech).not.toMatch(/tracking/i);
  });

  it("4 — yes correct sends support email", async () => {
    const session = seedUnverifiedOrderSession("CA_ESC_4");
    const sendSpy = vi.spyOn(resendEmailService, "sendSupportEscalationDetailed").mockResolvedValue({
      ok: true,
      messageId: "msg_esc_4",
    });
    await collectSpeech(session, "what is the shipping address");
    await collectSpeech(session, "yes forward to support");
    await collectSpeech(session, "bashisahab64 at gmail dot com");
    const speech = await collectSpeech(session, "yes, correct");
    expect(sendSpy).toHaveBeenCalled();
    expect(getSupportEscalationState(session)).toBe("support_escalation_submitted");
    expect(speech).toMatch(/forwarded to our support team.*check your inbox/i);
  });

  it("5 — incorrect email confirmation asks again without tracking pivot", async () => {
    const session = seedUnverifiedOrderSession("CA_ESC_5");
    await collectSpeech(session, "tell me all order details");
    await collectSpeech(session, "yes forward it");
    await collectSpeech(session, "bashisahab64 at gmail dot com");
    const speech = await collectSpeech(session, "no that is wrong");
    expect(getSupportEscalationEmailState(session)).toBe("support_escalation_pending_email");
    expect(speech).toMatch(/email address/i);
    expect(speech).not.toMatch(/tracking|notepad/i);
  });

  it("6 — identity claim from another phone starts escalation", async () => {
    const session = seedUnverifiedOrderSession("CA_ESC_6");
    const speech = await collectSpeech(session, "I am calling from another phone");
    expect(getSupportEscalationEmailState(session)).toBe("support_escalation_pending_email");
    expect(speech).toMatch(/forward your details to our support team/i);
    expect(speech).not.toMatch(/shipping address|Private/i);
  });

  it("7 — accidental tracking mention during escalation stays in support flow", async () => {
    const session = seedUnverifiedOrderSession("CA_ESC_7");
    await collectSpeech(session, "what is the shipping address");
    await collectSpeech(session, "yes forward to support");
    const speech = await collectSpeech(session, "my tracking number is 12345");
    expect(getSupportEscalationEmailState(session)).toBe("support_escalation_pending_email");
    expect(speech).toMatch(/finish your support request first/i);
    expect(speech).not.toMatch(/notepad|pen and/i);
  });

  it("8 — state transitions log through deterministic resolver", async () => {
    const session = seedUnverifiedOrderSession("CA_ESC_8");
    armPrivateInfoBlockedEscalation(
      session,
      "shipping address",
      "Unverified caller requested vault-protected order information.",
    );

    await resolveSupportEscalationTurn(session, "yes forward to support");
    expect(getSupportEscalationEmailState(session)).toBe("support_escalation_pending_email");

    await resolveEmailConfirmationTurn(session, "bashisahab64 at gmail dot com");
    expect(getSupportEscalationEmailState(session)).toBe(
      "support_escalation_pending_email_confirmation",
    );
    expect(buildEmailConfirmationSpeech("bashisahab64@gmail.com")).toMatch(/Is that correct/i);

    vi.spyOn(resendEmailService, "sendSupportEscalationDetailed").mockResolvedValue({
      ok: true,
      messageId: "msg_esc_8",
    });
    await resolveEmailConfirmationTurn(session, "yes correct");
    expect(getSupportEscalationEmailState(session)).toBe("support_escalation_submitted");
  });

  it("extracts typed email directly", () => {
    expect(extractEmailFromSpeech("my email is bashisahab64@gmail.com")).toBe(
      "bashisahab64@gmail.com",
    );
  });
});
