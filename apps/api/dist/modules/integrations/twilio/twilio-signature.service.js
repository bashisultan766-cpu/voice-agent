"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwilioSignatureService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto = require("crypto");
const public_webhook_base_url_1 = require("../../../common/public-webhook-base-url");
let TwilioSignatureService = class TwilioSignatureService {
    constructor(config) {
        this.config = config;
    }
    isTrustedProxyUrlHeader(req) {
        const expected = this.config.get('TWILIO_PROXY_SHARED_SECRET')?.trim();
        if (!expected)
            return false;
        const provided = req.headers['x-twilio-proxy-secret']?.trim();
        if (!provided)
            return false;
        const providedBuf = Buffer.from(provided);
        const expectedBuf = Buffer.from(expected);
        if (providedBuf.length !== expectedBuf.length)
            return false;
        return crypto.timingSafeEqual(providedBuf, expectedBuf);
    }
    isValidationEnabled() {
        return this.config.get('VALIDATE_TWILIO_SIGNATURES') !== 'false';
    }
    validate(url, params, signature) {
        const authToken = this.config.get('TWILIO_AUTH_TOKEN');
        if (!authToken || !signature)
            return false;
        const payload = url + this.sortedParams(params);
        const expected = crypto
            .createHmac('sha1', authToken)
            .update(payload)
            .digest('base64');
        try {
            const sigBuf = Buffer.from(signature, 'base64');
            const expBuf = Buffer.from(expected, 'base64');
            if (sigBuf.length !== expBuf.length)
                return false;
            return crypto.timingSafeEqual(sigBuf, expBuf);
        }
        catch {
            return false;
        }
    }
    resolveValidationUrl(req) {
        const originalUrlHeader = req.headers['x-original-url']?.trim();
        if (originalUrlHeader && this.isTrustedProxyUrlHeader(req)) {
            try {
                return new URL(originalUrlHeader).toString();
            }
            catch {
            }
        }
        const fromProxyProto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim();
        const fromProxyHost = req.headers['x-forwarded-host']?.split(',')[0]?.trim();
        const proto = fromProxyProto || req.protocol || 'https';
        const host = fromProxyHost || req.get('host');
        const originalUrl = req.originalUrl || req.url || '';
        if (host && originalUrl) {
            return `${proto}://${host}${originalUrl}`;
        }
        const baseUrl = (0, public_webhook_base_url_1.normalizePublicWebhookBaseUrl)(this.config.get('PUBLIC_WEBHOOK_BASE_URL'));
        return `${baseUrl}${originalUrl}`;
    }
    sortedParams(params) {
        return Object.keys(params)
            .sort()
            .map((k) => k + params[k])
            .join('');
    }
};
exports.TwilioSignatureService = TwilioSignatureService;
exports.TwilioSignatureService = TwilioSignatureService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], TwilioSignatureService);
//# sourceMappingURL=twilio-signature.service.js.map