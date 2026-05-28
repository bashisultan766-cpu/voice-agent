"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePublicWebhookBaseUrl = normalizePublicWebhookBaseUrl;
exports.validatePublicWebhookBaseUrl = validatePublicWebhookBaseUrl;
function normalizePublicWebhookBaseUrl(raw) {
    let s = (raw ?? '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(s) && /\/api$/i.test(s)) {
        s = s.slice(0, -4).replace(/\/+$/, '');
    }
    return s;
}
const BLOCKED_HOST_PATTERNS = [
    /(^|\.)localhost$/i,
    /^127\.0\.0\.1$/i,
    /^0\.0\.0\.0$/i,
    /\.local$/i,
    /ngrok/i,
    /localtunnel/i,
    /example/i,
];
function validatePublicWebhookBaseUrl(raw) {
    const normalized = normalizePublicWebhookBaseUrl(raw);
    if (!normalized)
        return { ok: false, normalized, reason: 'missing' };
    let parsed;
    try {
        parsed = new URL(normalized);
    }
    catch {
        return { ok: false, normalized, reason: 'invalid_url' };
    }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') {
        return { ok: false, normalized, reason: 'not_https', host };
    }
    if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
        return { ok: false, normalized, reason: 'blocked_host', host };
    }
    return { ok: true, normalized, host };
}
//# sourceMappingURL=public-webhook-base-url.js.map