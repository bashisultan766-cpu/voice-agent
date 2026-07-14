/**
 * Provider-agnostic email helpers. Never imports Resend / Shopify / net.
 * Any module that needs to validate or format an email should import from here
 * — not from `resendEmailService.ts`.
 */

/** Trim + lowercase host for stable equality checks. */
export function normalizeEmail(input: string | null | undefined): string {
  if (!input) return "";
  const trimmed = String(input).trim();
  if (!trimmed) return "";
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0) return trimmed;
  const local = trimmed.slice(0, atIdx);
  const host = trimmed.slice(atIdx + 1).toLowerCase();
  return `${local}@${host}`;
}

/** RFC-ish structural validation — accepts any provider domain. */
export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const trimmed = String(email).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/** Truncated form for logs / unverified callers — e.g. `...@gmail.com`. */
export function maskEmailForDisplay(email: string | null | undefined): string {
  if (!email) return "";
  const trimmed = String(email).trim();
  if (!trimmed || !trimmed.includes("@")) return "";
  const domain = trimmed.split("@").pop();
  if (!domain) return "";
  return `...@${domain.toLowerCase()}`;
}
