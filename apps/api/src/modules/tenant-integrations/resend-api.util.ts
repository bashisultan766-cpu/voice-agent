/** Build a Resend `from` header: plain email or `Display Name <email>`. */
export function formatResendFromAddress(fromEmail: string, fromName?: string): string {
  const email = fromEmail.trim();
  const name = fromName?.trim();
  if (!name) return email;
  const safeName = name.replace(/[<>"]/g, '');
  return `${safeName} <${email}>`;
}

/** Prefer Resend JSON `message`, then a short HTTP body snippet. */
export function parseResendApiErrorMessage(status: number, bodyText: string, json: unknown): string {
  if (json && typeof json === 'object') {
    const rec = json as Record<string, unknown>;
    if (typeof rec.message === 'string' && rec.message.trim()) return rec.message.trim();
    if (Array.isArray(rec.message) && typeof rec.message[0] === 'string') {
      return rec.message[0].trim();
    }
  }
  const snippet = bodyText.trim().slice(0, 240);
  return snippet ? `Resend API returned ${status}: ${snippet}` : `Resend API returned ${status}.`;
}
