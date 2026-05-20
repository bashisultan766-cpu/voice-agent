/**
 * Strip payment-like patterns from caller speech before persisting or sending to the LLM.
 * Not a full PCI audit — reduces accidental card-number capture in transcripts.
 */
export function redactPaymentLikePatterns(text: string): string {
  if (!text?.trim()) return text;
  let out = text;
  // Long digit runs typical of card PANs (allow separators).
  out = out.replace(/\b(?:\d[ \-]*?){13,19}\b/g, '[payment detail removed]');
  out = out.replace(/\bcvv\b[\s:]*\d{3,4}\b/gi, 'cvv [removed]');
  out = out.replace(/\bcvc\b[\s:]*\d{3,4}\b/gi, 'cvc [removed]');
  out = out.replace(/\bsecurity code\b[\s:]*\d{3,4}\b/gi, 'security code [removed]');
  return out;
}
