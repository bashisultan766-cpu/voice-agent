/**
 * Normalize caller/provider phone numbers to E.164-style (+digits) for DB lookup and Twilio `To` matching.
 *
 * - Strips spaces, dashes, parentheses, etc.
 * - **NANP (US/Canada)**: 10-digit input (no country code) is treated as US and prefixed with `1`
 *   so `(251) 255-4549` and `2512554549` become `+12512554549`, matching Twilio's `To`.
 * - Values that already include a leading country code (e.g. 11 digits starting with 1) stay as `+` + digits.
 */
export function normalizePhoneNumber(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';

  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return trimmed;

  // Strip leading trunk 0 (common outside NANP); keep remaining digits
  if (digits.length > 2 && digits.slice(0, 2) === '00') {
    digits = digits.slice(2);
  }

  // NANP: 10 digits → assume US country code 1
  if (digits.length === 10) {
    digits = `1${digits}`;
  }

  return `+${digits}`;
}
