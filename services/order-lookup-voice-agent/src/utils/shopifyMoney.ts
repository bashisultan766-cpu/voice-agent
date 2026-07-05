/**
 * Normalize catalog / cart prices into Shopify money strings (e.g. "10.00").
 */
export function normalizeShopifyUnitPrice(raw: string | number | undefined | null): string {
  if (raw === undefined || raw === null) return "0.00";
  const cleaned = String(raw).trim().replace(/^\$/, "");
  if (!cleaned) return "0.00";
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return "0.00";
  return value.toFixed(2);
}

/** Line merchandise total = unit price × quantity. */
export function formatLineTotal(unitPrice: string | undefined, quantity: number): string {
  const unit = Number(normalizeShopifyUnitPrice(unitPrice));
  const qty = Math.max(1, quantity || 1);
  return (unit * qty).toFixed(2);
}

/** Sum of all line merchandise totals (excludes shipping/tax). */
export function sumCartMerchandiseTotal(
  items: Array<{ unitPrice?: string; price?: string; quantity: number }>,
): string {
  const total = items.reduce((sum, item) => {
    const unitPrice = item.unitPrice ?? item.price;
    return sum + Number(formatLineTotal(unitPrice, item.quantity));
  }, 0);
  return total.toFixed(2);
}
