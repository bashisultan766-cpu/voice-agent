export type PaymentEmailItem = {
    title: string;
    quantity: number;
    price?: string | null;
};
export type PaymentEmailBranding = {
    businessName: string;
    supportEmail?: string | null;
    supportPhone?: string | null;
    checkoutUrl: string;
    items: PaymentEmailItem[];
};
export declare function buildPaymentEmailContent(branding: PaymentEmailBranding): {
    subject: string;
    html: string;
    text: string;
    bodyPreview: string;
};
