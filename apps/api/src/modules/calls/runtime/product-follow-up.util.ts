/** Stable key so we only offer the soft payment follow-up once per distinct product. */
export function normalizeProductFollowUpKey(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}
