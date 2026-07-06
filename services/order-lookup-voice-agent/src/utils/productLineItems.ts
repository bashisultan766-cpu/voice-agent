/**
 * Filters non-physical Shopify line items (fees, shipping surcharges) from book counts.
 */

const NON_PHYSICAL_EXACT = new Set(["processing fee", "shipping", "handling"]);

/** True when the line item represents a physical book (not a fee or surcharge). */
export function isPhysicalBookLineItem(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return false;
  if (NON_PHYSICAL_EXACT.has(normalized)) return false;
  if (/^processing fee\b/i.test(normalized)) return false;
  if (/^shipping\b/i.test(normalized)) return false;
  if (/^handling\b/i.test(normalized)) return false;
  return true;
}

export function filterPhysicalLineItems<T extends { title: string; quantity: number }>(
  items: T[],
): T[] {
  return items.filter((item) => isPhysicalBookLineItem(item.title));
}

export function physicalItemCount(
  items: Array<{ title: string; quantity: number }>,
): number {
  return filterPhysicalLineItems(items).reduce((sum, line) => sum + line.quantity, 0);
}
