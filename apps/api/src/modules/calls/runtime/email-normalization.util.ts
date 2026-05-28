export function normalizeSpokenEmail(email: string): string {
  const cleaned = email.trim().toLowerCase();
  if (!cleaned) return cleaned;
  const numberWords: Record<string, string> = {
    zero: '0',
    one: '1',
    two: '2',
    three: '3',
    four: '4',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    nine: '9',
  };
  let normalized = cleaned.replace(/\bat\b/g, '@').replace(/\bdot\b/g, '.');
  for (const [word, digit] of Object.entries(numberWords)) {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
  }
  normalized = normalized.replace(/\s+/g, '');
  return normalized;
}
