export declare function normalizePublicWebhookBaseUrl(raw: string | undefined | null): string;
export declare function validatePublicWebhookBaseUrl(raw: string | undefined | null): {
    ok: boolean;
    normalized: string;
    reason?: 'missing' | 'invalid_url' | 'not_https' | 'blocked_host';
    host?: string;
};
