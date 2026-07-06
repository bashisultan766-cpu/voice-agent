/**
 * Filters non-physical Shopify line items (fees, shipping surcharges) from book counts.
 */

const NON_PHYSICAL_EXACT = new Set(["processing fee", "shipping", "handling"]);

/** Fee / surcharge line — never counted or spoken as a book. */
export function isFeeLineItem(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return false;
  if (NON_PHYSICAL_EXACT.has(normalized)) return true;
  if (/\bfee\b/i.test(title)) return true;
  if (/\bshipping\b/i.test(title)) return true;
  if (/\bhandling\b/i.test(title)) return true;
  return false;
}

/** True when the line item represents a physical book (not a fee or surcharge). */
export function isPhysicalBookLineItem(title: string): boolean {
  return !isFeeLineItem(title);
}

export function filterPhysicalLineItems<T extends { title: string; quantity: number }>(
  items: T[],
): T[] {
  return items.filter((item) => isPhysicalBookLineItem(item.title));
}

export function filterFeeLineItems<T extends { title: string; quantity: number }>(
  items: T[],
): T[] {
  return items.filter((item) => isFeeLineItem(item.title));
}

export function splitLineItems<T extends { title: string; quantity: number }>(
  items: T[],
): { physicalItems: T[]; feeItems: T[] } {
  const physicalItems: T[] = [];
  const feeItems: T[] = [];
  for (const item of items) {
    if (isFeeLineItem(item.title)) {
      feeItems.push(item);
    } else {
      physicalItems.push(item);
    }
  }
  return { physicalItems, feeItems };
}

export function physicalItemCount(
  items: Array<{ title: string; quantity: number }>,
): number {
  return filterPhysicalLineItems(items).reduce((sum, line) => sum + line.quantity, 0);
}
