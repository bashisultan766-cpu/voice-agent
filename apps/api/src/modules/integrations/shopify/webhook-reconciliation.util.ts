export function buildPaymentWebhookEventKey(topic: string, orderId: string, tenantId: string, checkoutLinkId: string): string {
  return `${topic}:${orderId}:${tenantId}:${checkoutLinkId}`;
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function minimalWebhookPayload(topic: string, payload: {
  id?: number | string;
  name?: string;
  financial_status?: string;
  created_at?: string;
  updated_at?: string;
  cancelled_at?: string;
  closed_at?: string;
  email?: string | null;
  contact_email?: string | null;
}) {
  const email = payload.email || payload.contact_email || null;
  return {
    topic,
    orderId: payload.id != null ? String(payload.id) : null,
    orderName: payload.name ?? null,
    financialStatus: payload.financial_status ?? null,
    createdAt: payload.created_at ?? null,
    updatedAt: payload.updated_at ?? null,
    cancelledAt: payload.cancelled_at ?? null,
    closedAt: payload.closed_at ?? null,
    maskedCustomerEmail: maskEmail(email),
  };
}
