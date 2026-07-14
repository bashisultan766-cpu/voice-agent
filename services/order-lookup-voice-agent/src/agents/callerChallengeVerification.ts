/**
 * Smart verification challenges — when phone match fails, keep shipping in the
 * secure vault and expose only challenge targets (zip / PO box / street number)
 * so the caller can unlock disclosure without a new Shopify lookup.
 */
import type { CallSession } from "../types/order.js";
import { ensureSessionMemory } from "./sessionMemory.js";
import { getSecureOrderVault, clearSecureOrderVault } from "./callSecureVault.js";
import {
  getActiveOrderContext,
  saveActiveOrderContext,
} from "./sessionManager.js";
import { mutateUnifiedSession } from "./unifiedCallSession.js";

export interface VerificationChallengeTargets {
  expectedZipCode?: string;
  expectedPoBoxOrStreet?: string;
}

const MAX_CHALLENGE_ATTEMPTS = 3;

/** Normalize spoken zip to digits (5 or 9). */
export function normalizeZipInput(raw: string): string {
  return (raw ?? "").replace(/\D/g, "").slice(0, 9);
}

/** Normalize street / PO box tokens for loose spoken match. */
export function normalizeStreetOrPoInput(raw: string): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/p\.?\s*o\.?\s*box/gi, "pobox")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Derive challenge targets from a formatted shipping address string
 * (e.g. "Name, PO Box 12, City, ST, 62701, US").
 */
export function extractChallengeTargets(
  shippingAddress: string | undefined | null,
): VerificationChallengeTargets {
  const text = (shippingAddress ?? "").trim();
  if (!text) return {};

  const zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  const poMatch = text.match(/P\.?\s*O\.?\s*Box\s*#?\s*([A-Za-z0-9-]+)/i);
  const streetNumMatch = text.match(/(?:^|,\s*)(\d{1,6})\s+[A-Za-z]/);

  const expectedZipCode = zipMatch?.[1] ? normalizeZipInput(zipMatch[1]) : undefined;
  const expectedPoBoxOrStreet = poMatch?.[1]
    ? normalizeStreetOrPoInput(`pobox${poMatch[1]}`)
    : streetNumMatch?.[1]
      ? normalizeStreetOrPoInput(streetNumMatch[1])
      : undefined;

  return { expectedZipCode, expectedPoBoxOrStreet };
}

/** Arm challenge state after an unverified found-order lookup. */
export function armVerificationChallenge(session: CallSession): void {
  const memory = ensureSessionMemory(session);
  if (session.isVerifiedCaller === true) {
    memory.verificationChallengePending = false;
    memory.expectedZipCode = undefined;
    memory.expectedPoBoxOrStreet = undefined;
    memory.challengeAttempts = undefined;
    memory.verificationStatus = "verified";
    return;
  }

  const vault = getSecureOrderVault(session.callSid);
  const targets = extractChallengeTargets(vault?.shippingAddress);
  if (!targets.expectedZipCode && !targets.expectedPoBoxOrStreet) {
    memory.verificationChallengePending = false;
    memory.verificationStatus = "non_verified";
    return;
  }

  memory.verificationChallengePending = true;
  memory.expectedZipCode = targets.expectedZipCode;
  memory.expectedPoBoxOrStreet = targets.expectedPoBoxOrStreet;
  memory.challengeAttempts = 0;
  memory.verificationStatus = "non_verified";
}

function inputMatchesChallenge(
  userInput: string,
  memory: ReturnType<typeof ensureSessionMemory>,
): boolean {
  const digits = normalizeZipInput(userInput);
  const street = normalizeStreetOrPoInput(userInput);
  const zipOk =
    Boolean(memory.expectedZipCode) &&
    digits.length >= 5 &&
    (digits === memory.expectedZipCode ||
      digits.startsWith(memory.expectedZipCode!) ||
      memory.expectedZipCode!.startsWith(digits.slice(0, 5)));
  const streetOk =
    Boolean(memory.expectedPoBoxOrStreet) &&
    street.length > 0 &&
    (street === memory.expectedPoBoxOrStreet ||
      street.includes(memory.expectedPoBoxOrStreet!) ||
      memory.expectedPoBoxOrStreet!.includes(street));
  return zipOk || streetOk;
}

export interface VerifyCallerChallengeResult {
  ok: boolean;
  verified: boolean;
  message: string;
  orderView?: import("./orderDisclosurePolicy.js").OrderView | null;
}

/**
 * Atomic challenge verification — flips isVerifiedCaller and unlocks vault
 * shipping into OrderView without a new Shopify API lookup.
 */
export async function verifyCallerChallenge(
  session: CallSession,
  userInputZipOrStreet: string,
): Promise<VerifyCallerChallengeResult> {
  return mutateUnifiedSession(session, async () => {
    const memory = ensureSessionMemory(session);
    if (session.isVerifiedCaller === true) {
      return {
        ok: true,
        verified: true,
        message: "Caller is already verified. Shipping details are available.",
        orderView: getActiveOrderContext(session) ?? null,
      };
    }

    if (memory.verificationChallengePending !== true) {
      return {
        ok: false,
        verified: false,
        message:
          "No verification challenge is pending. Look up an order first, then ask for the zip code or street number on the shipping address.",
      };
    }

    const attempts = (memory.challengeAttempts ?? 0) + 1;
    memory.challengeAttempts = attempts;

    if (!inputMatchesChallenge(userInputZipOrStreet ?? "", memory)) {
      const remaining = Math.max(0, MAX_CHALLENGE_ATTEMPTS - attempts);
      return {
        ok: false,
        verified: false,
        message:
          remaining > 0
            ? `That didn't match. You can try the zip code or street / PO Box number again (${remaining} ${remaining === 1 ? "try" : "tries"} left).`
            : "I couldn't verify that address detail. I can still help with order status, items, and totals — or connect you with support for the shipping address.",
      };
    }

    const vault = getSecureOrderVault(session.callSid);
    session.isVerifiedCaller = true;
    memory.verificationStatus = "verified";
    memory.verificationChallengePending = false;
    memory.expectedZipCode = undefined;
    memory.expectedPoBoxOrStreet = undefined;
    memory.challengeAttempts = undefined;

    const prior = (getActiveOrderContext(session) ?? {}) as Record<string, unknown>;
    saveActiveOrderContext(session, {
      ...prior,
      shipping_address: vault?.shippingAddress,
      past_order_history: vault?.pastOrderHistory,
    });

    // Vault may stay for the call in case of reconnect; disclosure is now unlocked.
    return {
      ok: true,
      verified: true,
      message:
        "Verified — shipping address and previously redacted details are now unlocked for this call.",
      orderView: getActiveOrderContext(session),
    };
  });
}

export function clearVerificationChallenge(session: CallSession): void {
  const memory = ensureSessionMemory(session);
  memory.verificationChallengePending = false;
  memory.expectedZipCode = undefined;
  memory.expectedPoBoxOrStreet = undefined;
  memory.challengeAttempts = undefined;
  clearSecureOrderVault(session.callSid);
}

export const CallerChallengeVerification = {
  arm: armVerificationChallenge,
  verify: verifyCallerChallenge,
  extractTargets: extractChallengeTargets,
  clear: clearVerificationChallenge,
} as const;
