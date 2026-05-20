export declare function buildPaymentWebhookEventKey(topic: string, orderId: string, tenantId: string, checkoutLinkId: string): string;
export declare function maskEmail(email: string | null | undefined): string | null;
export declare function minimalWebhookPayload(topic: string, payload: {
    id?: number | string;
    name?: string;
    financial_status?: string;
    created_at?: string;
    updated_at?: string;
    cancelled_at?: string;
    closed_at?: string;
    email?: string | null;
    contact_email?: string | null;
}): {
    topic: string;
    orderId: string | null;
    orderName: string | null;
    financialStatus: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    cancelledAt: string | null;
    closedAt: string | null;
    maskedCustomerEmail: string | null;
};
