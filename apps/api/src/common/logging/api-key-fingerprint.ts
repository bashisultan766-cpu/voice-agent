/** First 8 + last 4 of a secret for logs; never log full keys. */
export function fingerprintApiKey(key: string | null | undefined): string | null {
  const t = key?.trim();
  if (!t) return null;
  if (t.length <= 12) return `${t.slice(0, 4)}…${t.slice(-2)}`;
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}
