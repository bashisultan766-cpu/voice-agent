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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var ShopifyController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const tenant_id_decorator_1 = require("../../../common/decorators/tenant-id.decorator");
const shopify_service_1 = require("./shopify.service");
const safe_log_1 = require("../../../common/logging/safe-log");
const roles_decorator_1 = require("../../../common/decorators/roles.decorator");
const client_1 = require("@prisma/client");
let ShopifyController = ShopifyController_1 = class ShopifyController {
    constructor(shopify) {
        this.shopify = shopify;
        this.logger = new common_1.Logger(ShopifyController_1.name);
    }
    async status(tenantId, agentId) {
        if (!agentId?.trim())
            throw new common_1.BadRequestException('agentId is required.');
        return this.shopify.getConnectionStatus(tenantId, agentId.trim());
    }
    async health(tenantId, agentId) {
        if (!agentId?.trim())
            throw new common_1.BadRequestException('agentId is required.');
        return this.shopify.getWebhookHealth(tenantId, agentId.trim());
    }
    async oauthStart(tenantId, agentId, shop, res) {
        if (!agentId?.trim())
            throw new common_1.BadRequestException('agentId is required.');
        if (!shop?.trim())
            throw new common_1.BadRequestException('shop is required (your-store.myshopify.com).');
        this.logger.log(`oauth.start tenant=${tenantId} agentId=${agentId.trim()} shop=${shop.trim().toLowerCase()}`);
        const installUrl = this.shopify.buildInstallUrl(tenantId, agentId.trim(), shop.trim());
        return res.redirect(installUrl);
    }
    async disconnect(tenantId, body) {
        const agentId = body?.agentId?.trim();
        if (!agentId)
            throw new common_1.BadRequestException('agentId is required.');
        return this.shopify.disconnect(tenantId, agentId);
    }
    async oauthCallback(req, res) {
        const fullUrl = new URL(req.originalUrl, 'http://localhost');
        const result = await this.shopify.handleOAuthCallback(fullUrl.searchParams);
        this.logger.log('oauth.callback completed');
        return res.redirect(result.redirectUrl);
    }
    async webhooks(req, res, topic, shopDomain, signature, parsedBody) {
        const topicSafe = topic ?? 'unknown';
        const domainSafe = (shopDomain ?? '').toLowerCase();
        try {
            const raw = Buffer.isBuffer(req.body)
                ? req.body
                : Buffer.from(JSON.stringify(parsedBody ?? {}), 'utf8');
            const valid = this.shopify.verifyWebhookSignature(raw, signature ?? '');
            if (!valid) {
                await this.shopify.recordWebhookFailure(topicSafe, domainSafe, 'Invalid Shopify webhook signature');
                this.logger.warn(`webhook signature invalid topic=${topicSafe} shop=${domainSafe} payload=${JSON.stringify((0, safe_log_1.redactSecrets)(parsedBody)).slice(0, 500)}`);
                throw new common_1.BadRequestException('Invalid Shopify webhook signature.');
            }
            let payload = parsedBody;
            if (Buffer.isBuffer(req.body)) {
                const rawText = req.body.toString('utf8');
                payload = rawText ? JSON.parse(rawText) : {};
            }
            await this.shopify.handleWebhook(topicSafe, domainSafe, payload);
            return res.status(200).send('ok');
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown webhook processing error';
            await this.shopify.recordWebhookFailure(topicSafe, domainSafe, message, parsedBody).catch(() => undefined);
            this.logger.error(`webhook processing failed topic=${topicSafe} shop=${domainSafe} message=${message} payload=${JSON.stringify((0, safe_log_1.redactSecrets)(parsedBody)).slice(0, 500)}`);
            throw err;
        }
    }
};
exports.ShopifyController = ShopifyController;
__decorate([
    (0, common_1.Get)('status'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)('agentId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ShopifyController.prototype, "status", null);
__decorate([
    (0, common_1.Get)('health'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)('agentId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ShopifyController.prototype, "health", null);
__decorate([
    (0, common_1.Get)('oauth/start'),
    (0, throttler_1.Throttle)({ default: { limit: 20, ttl: 60_000 } }),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)('agentId')),
    __param(2, (0, common_1.Query)('shop')),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", Promise)
], ShopifyController.prototype, "oauthStart", null);
__decorate([
    (0, common_1.Post)('disconnect'),
    (0, throttler_1.Throttle)({ default: { limit: 15, ttl: 60_000 } }),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ShopifyController.prototype, "disconnect", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.SkipThrottle)(),
    (0, common_1.Get)('oauth/callback'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ShopifyController.prototype, "oauthCallback", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.SkipThrottle)(),
    (0, common_1.Post)('webhooks'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __param(2, (0, common_1.Headers)('x-shopify-topic')),
    __param(3, (0, common_1.Headers)('x-shopify-shop-domain')),
    __param(4, (0, common_1.Headers)('x-shopify-hmac-sha256')),
    __param(5, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, String, Object]),
    __metadata("design:returntype", Promise)
], ShopifyController.prototype, "webhooks", null);
exports.ShopifyController = ShopifyController = ShopifyController_1 = __decorate([
    (0, common_1.Controller)('integrations/shopify'),
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    __metadata("design:paramtypes", [shopify_service_1.ShopifyService])
], ShopifyController);
//# sourceMappingURL=shopify.controller.js.map