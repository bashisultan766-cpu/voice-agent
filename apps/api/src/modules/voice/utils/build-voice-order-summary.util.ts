import type { VoiceOrderDetailDto } from '../dto/get-order.dto';

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function humanizeStatus(value: string | null | undefined): string {
  if (!value) return 'unknown';
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function describeFinancialStatus(order: VoiceOrderDetailDto): string {
  if (order.cancelledAt) {
    const reason = order.cancelReason ? ` Reason: ${humanizeStatus(order.cancelReason)}.` : '';
    return `This order was cancelled on ${formatDate(order.cancelledAt) ?? 'record'}.${reason}`;
  }
  if (order.refunds.length > 0) {
    const latest = order.refunds[order.refunds.length - 1];
    const amount = latest.amount ? ` for ${latest.amount}` : '';
    return `A refund was issued on ${formatDate(latest.createdAt) ?? 'record'}${amount}. Current payment status: ${humanizeStatus(order.financialStatus)}.`;
  }
  return `Payment status is ${humanizeStatus(order.financialStatus)}.`;
}

function describeFulfillment(order: VoiceOrderDetailDto): string {
  const parts: string[] = [];
  const base = humanizeStatus(order.fulfillmentStatus);
  parts.push(`Fulfillment status is ${base}.`);

  const activeFulfillments = order.fulfillments.filter(
    (f) => f.displayStatus || f.status || f.tracking.length > 0,
  );
  if (!activeFulfillments.length) {
    if (base.toLowerCase().includes('unfulfilled') || base.toLowerCase().includes('unshipped')) {
      parts.push('The order has not shipped yet.');
    }
    return parts.join(' ');
  }

  for (const fulfillment of activeFulfillments) {
    const status = humanizeStatus(fulfillment.displayStatus ?? fulfillment.status);
    const tracking = fulfillment.tracking.find((t) => t.number || t.company);
    if (tracking?.number) {
      const carrier = tracking.company ? ` via ${tracking.company}` : '';
      parts.push(`Tracking number ${tracking.number}${carrier}. Status: ${status}.`);
    } else {
      parts.push(`Shipment status: ${status}.`);
    }

    const delivered = formatDate(fulfillment.deliveredAt);
    if (delivered) {
      parts.push(`Delivered on ${delivered}.`);
      continue;
    }
    const eta = formatDate(fulfillment.estimatedDeliveryAt);
    if (eta) {
      parts.push(`Estimated delivery ${eta}.`);
    } else if (fulfillment.inTransitAt) {
      parts.push('The package is in transit.');
    }
  }

  return parts.join(' ');
}

function describeLineItems(order: VoiceOrderDetailDto): string {
  if (!order.lineItems.length) return '';
  const items = order.lineItems.map((line) => {
    const variant = line.variantTitle ? ` (${line.variantTitle})` : '';
    const qty = line.quantity > 1 ? `${line.quantity} copies of ` : '';
    return `${qty}${line.title}${variant}`;
  });
  if (items.length === 1) return `Item: ${items[0]}.`;
  return `Items: ${items.join('; ')}.`;
}

function describeShippingAddress(order: VoiceOrderDetailDto): string {
  const addr = order.shippingAddress;
  if (!addr) return '';
  const cityLine = [addr.city, addr.provinceCode].filter(Boolean).join(', ');
  const pieces = [addr.name, addr.address1, cityLine, addr.zip].filter(Boolean);
  if (!pieces.length) return '';
  return `Shipping to ${pieces.join(', ')}.`;
}

/** Natural-language summary for the voice agent — only use returned tool data. */
export function buildVoiceOrderSummary(order: VoiceOrderDetailDto): string {
  const placed = formatDate(order.createdAt);
  const header = placed
    ? `Order ${order.orderNumber} was placed on ${placed}.`
    : `Order ${order.orderNumber}.`;

  const customer =
    order.customerName?.trim() ? `Customer: ${order.customerName.trim()}.` : '';

  const total = order.totalPrice
    ? `Order total ${order.totalPrice}${order.currency ? ` ${order.currency}` : ''}.`
    : '';

  return [
    header,
    customer,
    describeFinancialStatus(order),
    describeFulfillment(order),
    describeLineItems(order),
    describeShippingAddress(order),
    total,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
