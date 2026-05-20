export declare function paymentEmailIdempotencyKey(parts: {
    tenantId: string;
    agentId: string;
    checkoutLinkId: string;
    recipientEmail: string;
    purpose?: string;
}): string;
