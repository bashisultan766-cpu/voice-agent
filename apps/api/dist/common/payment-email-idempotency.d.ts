export declare function paymentRecipientPairIdempotencyKey(parts: {
    tenantId: string;
    agentId: string;
    productId: string;
    recipientEmail: string;
    callSid?: string | null;
}): string;
export declare function paymentEmailIdempotencyKey(parts: {
    tenantId: string;
    agentId: string;
    checkoutLinkId: string;
    recipientEmail: string;
    purpose?: string;
}): string;
