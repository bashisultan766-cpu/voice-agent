/** Customer-facing copy rules for SureShot Books voice tools. */

export const SUBTOTAL_DISCLAIMER = 'Subtotal does not include shipping.';

const PROCESSING_FEE_RE = /\bprocessing\s+fees?\b/gi;

/** Never expose "processing fee" in agent speech — replace with neutral order-total language. */
export function sanitizeCustomerFacingText(text: string): string {
  return text.replace(PROCESSING_FEE_RE, 'order total').replace(/\s+/g, ' ').trim();
}

export function buildSubtotalSpokenLine(subtotal: string | null, currency = 'USD'): string {
  if (!subtotal) {
    return `I can share the subtotal before shipping once I confirm the order details. ${SUBTOTAL_DISCLAIMER}`;
  }
  const formatted = formatMoney(subtotal, currency);
  return sanitizeCustomerFacingText(
    `The subtotal before shipping is ${formatted}. ${SUBTOTAL_DISCLAIMER}`,
  );
}

export function formatMoney(amount: string, currency = 'USD'): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
}

export function inventoryStatusPhrase(status: string): string {
  switch (status) {
    case 'in_stock':
      return 'This title is in stock.';
    case 'out_of_stock':
      return 'This title is currently not in stock.';
    case 'backorder':
      return 'This title is currently on backorder.';
    case 'discontinued':
      return 'This title is discontinued and not available for new orders.';
    case 'unknown':
    default:
      return 'I need customer service to confirm current inventory for this title.';
  }
}

export function maskTrackingNumber(tracking: string | null | undefined): string | null {
  if (!tracking?.trim()) return null;
  const t = tracking.trim();
  if (t.length <= 4) return '****';
  return `***${t.slice(-4)}`;
}
