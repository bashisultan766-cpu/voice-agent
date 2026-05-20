/**
 * Normalize caller/provider phone numbers to E.164-style (+digits) for DB lookup and Twilio `To` matching.
 *
 * - Strips spaces, dashes, parentheses, etc.
 * - **NANP (US/Canada)**: 10-digit input (no country code) is treated as US and prefixed with `1`
 *   so `(251) 255-4549` and `2512554549` become `+12512554549`, matching Twilio's `To`.
 * - Values that already include a leading country code (e.g. 11 digits starting with 1) stay as `+` + digits.
 */
export declare function normalizePhoneNumber(raw: string): string;
//# sourceMappingURL=phone.d.ts.map