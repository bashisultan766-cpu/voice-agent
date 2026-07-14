import { describe, expect, it } from "vitest";
import { parseCustomerLedgerNote, formatCreditBalanceSpeech } from "../src/agents/ledgerNoteParser.js";
import {
  extractChallengeTargets,
  normalizeZipInput,
  armVerificationChallenge,
  verifyCallerChallenge,
} from "../src/agents/callerChallengeVerification.js";
import { storeSecureOrderVault, clearSecureOrderVault } from "../src/agents/callSecureVault.js";
import type { CallSession } from "../src/types/order.js";
import { ensureSessionMemory } from "../src/agents/sessionMemory.js";

function baseSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callSid: "CA_CHALLENGE_TEST",
    from: "+15551234567",
    to: "+15557654321",
    isVerifiedCaller: false,
    ...overrides,
  } as CallSession;
}

describe("ledgerNoteParser", () => {
  it("parses deposit / total / credit balance from ledger-style notes", () => {
    const parsed = parseCustomerLedgerNote(
      "Account Deposit $65.00 - Total Order $40.00 = Current Credit Balance $25.00",
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.deposit).toBe(65);
    expect(parsed?.totalOrder).toBe(40);
    expect(parsed?.creditBalance).toBe(25);
    expect(formatCreditBalanceSpeech(parsed!)).toContain("$25.00");
  });
});

describe("callerChallengeVerification", () => {
  it("extracts zip and PO box challenge targets from formatted shipping", () => {
    const targets = extractChallengeTargets(
      "Jane Doe, PO Box 12, Springfield, IL, 62701, US",
    );
    expect(targets.expectedZipCode).toBe("62701");
    expect(targets.expectedPoBoxOrStreet).toContain("12");
  });

  it("unlocks shipping after a correct zip challenge without re-fetch", async () => {
    const session = baseSession();
    clearSecureOrderVault(session.callSid);
    storeSecureOrderVault(session.callSid, {
      orderNumber: "21698",
      shippingAddress: "Jane Doe, 100 Main St, Springfield, IL, 62701, US",
    });
    armVerificationChallenge(session);
    const memory = ensureSessionMemory(session);
    expect(memory.verificationChallengePending).toBe(true);
    expect(memory.expectedZipCode).toBe("62701");

    const result = await verifyCallerChallenge(session, "six two seven oh one 62701");
    expect(result.verified).toBe(true);
    expect(session.isVerifiedCaller).toBe(true);
    expect(ensureSessionMemory(session).verificationChallengePending).toBeFalsy();
    clearSecureOrderVault(session.callSid);
  });

  it("normalizes zip digits from spoken clutter", () => {
    expect(normalizeZipInput("zip is 62-701 please")).toBe("62701");
  });
});
