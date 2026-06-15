import { maskEmail } from '../../integrations/shopify/webhook-reconciliation.util';
import type { VoiceOrderAddressDto, VoiceOrderDetailDto } from '../dto/get-order.dto';

export type VerifiedLevel = 'none' | 'partial' | 'full';

export type VoiceOrderVerificationFlags = {
  caller_phone: string | null;
  customer_phone: string | null;
  phone_matches_customer: boolean;
  verified_level: VerifiedLevel;
  can_share_address: boolean;
  can_share_full_name: boolean;
  can_share_email: boolean;
  can_share_only_masked_email: boolean;
  can_share_last4: boolean;
};

export type MaskedOrderFields = {
  masked_email: string | null;
  last4_card_or_id: string | null;
  masked_phone: string | null;
  partial_address: string | null;
};

export type VoiceOrderRefundSummary = {
  order_number: string;
  booking_date: string | null;
  refund_status: string;
  refund_amount: string | null;
  refund_date: string | null;
  masked_email: string | null;
  last4_card_or_id: string | null;
  customer_verification_status: VerifiedLevel;
};

export type PrivacySafeOrderDto = {
  id: string;
  orderNumber: string;
  createdAt: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  totalPrice: string | null;
  currency: string | null;
  lineItems: VoiceOrderDetailDto['lineItems'];
  fulfillments: VoiceOrderDetailDto['fulfillments'];
  refunds: VoiceOrderDetailDto['refunds'];
  paymentCardBrand: string | null;
  /** Full fields only when verification is full and policy allows. */
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  shippingAddress?: VoiceOrderAddressDto | null;
  paymentCardLast4?: string | null;
};

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function phonesMatch(callerPhone: string | null, customerPhone: string | null): boolean {
  if (!callerPhone || !customerPhone) return false;
  const a = digitsOnly(callerPhone);
  const b = digitsOnly(customerPhone);
  if (!a || !b) return false;
  const minLen = Math.min(a.length, b.length, 10);
  return a.slice(-minLen) === b.slice(-minLen);
}

export function maskPhoneForAgent(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;
  const digits = digitsOnly(phone);
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}

export function maskEmailForAgent(email: string | null | undefined): string | null {
  if (!email?.trim()) return null;
  return maskEmail(email.trim().toLowerCase());
}

export function buildPartialAddress(address: VoiceOrderAddressDto | null | undefined): string | null {
  if (!address) return null;
  const cityLine = [address.city, address.provinceCode].filter(Boolean).join(', ');
  const pieces = [cityLine, address.zip].filter(Boolean);
  if (!pieces.length) return null;
  return pieces.join(' ');
}

export function resolveVerificationFlags(args: {
  callerPhone?: string | null;
  customerPhone?: string | null;
  orderFound?: boolean;
}): VoiceOrderVerificationFlags {
  const caller_phone = args.callerPhone?.trim() || null;
  const customer_phone = args.customerPhone?.trim() || null;
  const phone_matches_customer = phonesMatch(caller_phone, customer_phone);

  let verified_level: VerifiedLevel = 'none';
  if (args.orderFound) {
    verified_level = phone_matches_customer ? 'full' : 'partial';
  }

  const can_share_address = verified_level === 'full';
  const can_share_full_name = verified_level === 'full';
  const can_share_email = verified_level === 'full';
  const can_share_only_masked_email = verified_level === 'partial' || verified_level === 'full';
  const can_share_last4 = verified_level === 'partial' || verified_level === 'full';

  return {
    caller_phone,
    customer_phone,
    phone_matches_customer,
    verified_level,
    can_share_address,
    can_share_full_name,
    can_share_email,
    can_share_only_masked_email,
    can_share_last4,
  };
}

export function buildMaskedOrderFields(
  order: VoiceOrderDetailDto,
  verification: VoiceOrderVerificationFlags,
): MaskedOrderFields {
  return {
    masked_email: verification.can_share_only_masked_email
      ? maskEmailForAgent(order.customerEmail)
      : null,
    last4_card_or_id:
      verification.can_share_last4 && order.paymentCardLast4 ? order.paymentCardLast4 : null,
    masked_phone: maskPhoneForAgent(order.customerPhone),
    partial_address: buildPartialAddress(order.shippingAddress),
  };
}

export function applyPrivacyToOrder(
  order: VoiceOrderDetailDto,
  verification: VoiceOrderVerificationFlags,
): PrivacySafeOrderDto {
  const base: PrivacySafeOrderDto = {
    id: order.id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    totalPrice: order.totalPrice,
    currency: order.currency,
    lineItems: order.lineItems,
    fulfillments: order.fulfillments,
    refunds: order.refunds,
    paymentCardBrand: order.paymentCardBrand,
  };

  if (verification.can_share_full_name) {
    base.customerName = order.customerName;
  }
  if (verification.can_share_email) {
    base.customerEmail = order.customerEmail;
  }
  if (verification.can_share_address) {
    base.shippingAddress = order.shippingAddress;
  }
  if (verification.can_share_last4) {
    base.paymentCardLast4 = order.paymentCardLast4;
  }

  return base;
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function buildRefundOrderSummary(
  order: VoiceOrderDetailDto,
  verification: VoiceOrderVerificationFlags,
  masked: MaskedOrderFields,
): VoiceOrderRefundSummary | null {
  if (!order.refunds.length) return null;

  const latest = order.refunds[order.refunds.length - 1];
  const hasRefund =
    order.financialStatus?.toLowerCase().includes('refund') ||
    order.refunds.length > 0 ||
    Number(latest.amount ?? 0) > 0;

  if (!hasRefund) return null;

  return {
    order_number: order.orderNumber,
    booking_date: formatDate(order.createdAt),
    refund_status: order.financialStatus ?? 'REFUNDED',
    refund_amount: latest.amount,
    refund_date: formatDate(latest.createdAt),
    masked_email: masked.masked_email,
    last4_card_or_id: masked.last4_card_or_id,
    customer_verification_status: verification.verified_level,
  };
}

/** Voice summary that never exposes full PII unless verification is full. */
export function buildPrivacyAwareVoiceOrderSummary(
  order: VoiceOrderDetailDto,
  verification: VoiceOrderVerificationFlags,
  masked: MaskedOrderFields,
): string {
  const placed = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  const parts: string[] = [
    placed
      ? `Order ${order.orderNumber} was placed on ${placed}.`
      : `Order ${order.orderNumber}.`,
    `Payment status is ${order.financialStatus ?? 'unknown'}.`,
    `Fulfillment status is ${order.fulfillmentStatus ?? 'unknown'}.`,
  ];

  if (order.refunds.length > 0) {
    const latest = order.refunds[order.refunds.length - 1];
    const amount = latest.amount ? ` of ${latest.amount}` : '';
    const card = masked.last4_card_or_id
      ? ` to the card ending in ${masked.last4_card_or_id}`
      : '';
    parts.push(`A refund${amount} was issued${card}.`);
    if (masked.masked_email) {
      parts.push(`Refund confirmation was sent to ${masked.masked_email}.`);
    }
  }

  const tracking = order.fulfillments
    .flatMap((f) => f.tracking)
    .find((t) => t.number);
  if (tracking?.number) {
    const carrier = tracking.company ? ` via ${tracking.company}` : '';
    parts.push(`Tracking number ${tracking.number}${carrier}.`);
  }

  if (verification.can_share_address && order.shippingAddress) {
    const addr = order.shippingAddress;
    const cityLine = [addr.city, addr.provinceCode].filter(Boolean).join(', ');
    const shipParts = [addr.address1, cityLine, addr.zip].filter(Boolean);
    if (shipParts.length) parts.push(`Shipping to ${shipParts.join(', ')}.`);
  } else if (masked.partial_address) {
    parts.push(`Shipping city/region on file: ${masked.partial_address}.`);
  }

  if (verification.can_share_full_name && order.customerName) {
    parts.push(`Customer name on file: ${order.customerName}.`);
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
