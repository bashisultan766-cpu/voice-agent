"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePublicWebhookBaseUrl = normalizePublicWebhookBaseUrl;
function normalizePublicWebhookBaseUrl(raw) {
    let s = (raw ?? '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(s) && /\/api$/i.test(s)) {
        s = s.slice(0, -4).replace(/\/+$/, '');
    }
    return s;
}
//# sourceMappingURL=public-webhook-base-url.js.map