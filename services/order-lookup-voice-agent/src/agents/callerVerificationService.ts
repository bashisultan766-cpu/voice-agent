/**
 * CallerVerificationService — E.164 normalize + verification gate (sole privacy identity owner).
 * Extends existing verificationGate / callerVerification — does not duplicate business rules.
 */
import type { CallSession } from "../types/order.js";
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import { applyCallerVerificationFromOrder } from "./callerVerification.js";
import { runVerificationGate as legacyRunVerificationGate } from "./verificationGate.js";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Normalize phone to E.164-ish digits with leading +. */
export function normalizeToE164(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export function phonesMatchE164(a?: string | null, b?: string | null): boolean {
  const na = normalizeToE164(a);
  const nb = normalizeToE164(b);
  if (!na || !nb) return false;
  return na === nb;
}

/** Validate Twilio webhook signature (X-Twilio-Signature). */
export function validateTwilioRequestSignature(input: {
  authToken: string;
  signature: string;
  url: string;
  params: Record<string, string>;
}): boolean {
  const { authToken, signature, url, params } = input;
  if (!authToken || !signature) return false;
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k] ?? ""}`)
    .join("");
  const data = url + sorted;
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function runCallerVerification(
  session: CallSession,
  result: OrderStatusResult,
): boolean {
  session.callerPhone = normalizeToE164(session.callerPhone ?? session.from) ?? session.callerPhone;
  const ok = legacyRunVerificationGate(session, result);
  applyCallerVerificationFromOrder(session, result);
  return session.isVerifiedCaller === true || ok;
}

export const CallerVerificationService = {
  normalizeToE164,
  phonesMatchE164,
  validateTwilioRequestSignature,
  run: runCallerVerification,
} as const;
