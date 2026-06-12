import { normalizePhoneNumber } from '../../twilio/utils/normalize-phone';

/** Last 10 digits — used to match NANP variants (+1xxxxxxxxxx vs xxxxxxxxxx). */
export function phoneDigitsKey(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length <= 10) return digits;
  return digits.slice(-10);
}

export function normalizeCallerPhone(raw: string): { normalized: string; digits: string } {
  const normalized = normalizePhoneNumber(raw) || (raw ?? '').trim();
  const digits = phoneDigitsKey(normalized || raw);
  return { normalized, digits };
}

export function phonesLikelyMatch(a: string, b: string): boolean {
  const left = normalizeCallerPhone(a);
  const right = normalizeCallerPhone(b);
  if (!left.normalized || !right.normalized) return false;
  if (left.normalized === right.normalized) return true;
  if (left.digits.length >= 10 && left.digits === right.digits) return true;
  return false;
}
