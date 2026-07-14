import { describe, expect, it } from "vitest";
import {
  OrderContextPromptFactory,
  buildStructuredContextBlocks,
  assembleStructuredContextSystemMessages,
  resolveOrderContextPromptSource,
} from "../src/agents/orderContextPromptFactory.js";
import type { CallSession } from "../src/types/order.js";
import { ensureSessionMemory } from "../src/agents/sessionMemory.js";

function makeSession(partial?: Partial<CallSession>): CallSession {
  return {
    callSid: "CA_PROMPT_FACTORY_TEST",
    from: "+15551234567",
    phase: "order_disclosed",
    awaitingInput: null,
    isVerifiedCaller: false,
    ...partial,
  } as CallSession;
}

describe("orderContextPromptFactory", () => {
  it("omits empty XML blocks when fields are missing", () => {
    const blocks = buildStructuredContextBlocks({
      orderMetafields: null,
      timelineAttachments: [],
      parsedCustomerBalance: null,
      verificationChallengePending: false,
      isVerifiedCaller: false,
    });
    expect(blocks.accountLedger).toBeNull();
    expect(blocks.subscriptionStatus).toBeNull();
    expect(blocks.verifiedAttachments).toBeNull();
    expect(blocks.verificationChallengeGate).toBeNull();
    expect(assembleStructuredContextSystemMessages(blocks)).toEqual([]);
  });

  it("injects ACCOUNT_LEDGER with credit offer instruction", () => {
    const blocks = buildStructuredContextBlocks({
      orderMetafields: null,
      timelineAttachments: [],
      parsedCustomerBalance: {
        deposit: 65,
        totalOrder: 40,
        creditBalance: 25,
      },
      verificationChallengePending: false,
      isVerifiedCaller: true,
    });
    expect(blocks.accountLedger).toContain("<ACCOUNT_LEDGER>");
    expect(blocks.accountLedger).toContain("$25.00");
    expect(blocks.accountLedger).toContain("proactively offer this credit");
    expect(blocks.accountLedger).not.toMatch(/undefined/);
  });

  it("injects SUBSCRIPTION_STATUS only when start/end dates exist", () => {
    const withoutDates = buildStructuredContextBlocks({
      orderMetafields: { productName: "Magazine", endDate: null, magazineStartDate: null },
      timelineAttachments: [],
      parsedCustomerBalance: null,
      verificationChallengePending: false,
      isVerifiedCaller: false,
    });
    expect(withoutDates.subscriptionStatus).toBeNull();

    const withDates = buildStructuredContextBlocks({
      orderMetafields: {
        productName: "Magazine",
        endDate: "2026-12-01",
        magazineStartDate: "2026-01-01",
      },
      timelineAttachments: [],
      parsedCustomerBalance: null,
      verificationChallengePending: false,
      isVerifiedCaller: false,
    });
    expect(withDates.subscriptionStatus).toContain("<SUBSCRIPTION_STATUS>");
    expect(withDates.subscriptionStatus).toContain("2026-01-01");
    expect(withDates.subscriptionStatus).toContain("natural voice phrasing");
  });

  it("injects VERIFIED_ATTACHMENTS with speakable dates", () => {
    const blocks = buildStructuredContextBlocks({
      orderMetafields: null,
      timelineAttachments: [
        {
          fileName: "ChristianSweeten_147455.pdf",
          timestamp: "2025-06-29T15:00:00.000Z",
        },
      ],
      parsedCustomerBalance: null,
      verificationChallengePending: false,
      isVerifiedCaller: false,
    });
    expect(blocks.verifiedAttachments).toContain("<VERIFIED_ATTACHMENTS>");
    expect(blocks.verifiedAttachments).toContain("ChristianSweeten_147455.pdf");
    expect(blocks.verifiedAttachments).toMatch(/June 29/);
  });

  it("gates speech: challenge pending omits ledger/subscription/attachments", () => {
    const blocks = buildStructuredContextBlocks({
      orderMetafields: {
        productName: "Mag",
        endDate: "2026-12-01",
        magazineStartDate: "2026-01-01",
      },
      timelineAttachments: [{ fileName: "secret.pdf", timestamp: null }],
      parsedCustomerBalance: { creditBalance: 25, deposit: 65, totalOrder: 40 },
      verificationChallengePending: true,
      isVerifiedCaller: false,
    });
    expect(blocks.accountLedger).toBeNull();
    expect(blocks.subscriptionStatus).toBeNull();
    expect(blocks.verifiedAttachments).toBeNull();
    expect(blocks.verificationChallengeGate).toContain("<VERIFICATION_CHALLENGE_GATE>");
    expect(blocks.verificationChallengeGate).toContain(
      OrderContextPromptFactory.CHALLENGE_DIALOG,
    );
    expect(assembleStructuredContextSystemMessages(blocks).join("\n")).not.toContain(
      "$25.00",
    );
    expect(assembleStructuredContextSystemMessages(blocks).join("\n")).not.toContain(
      "secret.pdf",
    );
  });

  it("resolves source from session memory + order context", () => {
    const session = makeSession();
    const memory = ensureSessionMemory(session);
    memory.verificationChallengePending = false;
    memory.parsedCustomerBalance = { creditBalance: 10, deposit: 50, totalOrder: 40 };

    const source = resolveOrderContextPromptSource(session, {
      order_metafields: {
        productName: null,
        endDate: "2027-01-01",
        magazineStartDate: null,
      },
      timeline_attachments: [{ fileName: "a.pdf", timestamp: null }],
    });
    expect(source.parsedCustomerBalance?.creditBalance).toBe(10);
    expect(source.orderMetafields?.endDate).toBe("2027-01-01");
    expect(source.timelineAttachments[0]?.fileName).toBe("a.pdf");
  });
});
