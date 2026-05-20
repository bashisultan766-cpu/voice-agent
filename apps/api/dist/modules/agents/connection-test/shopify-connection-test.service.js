"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyConnectionTestService = void 0;
const common_1 = require("@nestjs/common");
const SHOPIFY_API_VERSION = '2024-10';
const DEBUG = process.env.DEBUG_AGENTS === 'true' || process.env.NODE_ENV !== 'production';
function maskToken(token) {
    if (!token || token.length < 12)
        return '***';
    const a = token.slice(0, 6);
    const b = token.slice(-4);
    return `${a}****${b}`;
}
function normalizeStoreUrl(input) {
    let s = input.trim().replace(/\/$/, '');
    if (!s.match(/^https?:\/\//i))
        s = `https://${s}`;
    try {
        const parsed = new URL(s);
        const host = parsed.hostname.toLowerCase();
        const isCustomDomain = !host.endsWith('.myshopify.com') && host !== 'myshopify.com';
        return { url: `${parsed.origin}`.replace(/\/$/, ''), isCustomDomain };
    }
    catch {
        return { url: s, isCustomDomain: false };
    }
}
let ShopifyConnectionTestService = class ShopifyConnectionTestService {
    validateRequired(config) {
        const url = config.shopifyStoreUrl?.trim();
        const token = config.shopifyAdminToken?.trim();
        if (!url)
            return 'Shopify store URL is required to test the connection.';
        if (!token)
            return 'Shopify Admin access token is required to test the connection.';
        try {
            const { isCustomDomain } = normalizeStoreUrl(url);
            if (isCustomDomain) {
                return 'Use your store’s myshopify.com URL (e.g. https://your-store.myshopify.com). Custom domains are not supported for the Admin API.';
            }
        }
        catch {
            return 'Please enter a valid Shopify store URL (e.g. https://your-store.myshopify.com).';
        }
        return null;
    }
    async testConnection(config) {
        if (DEBUG)
            console.debug('[ShopifyTest:shopify] step=validate');
        const validationError = this.validateRequired(config);
        if (validationError) {
            if (DEBUG)
                console.debug('[ShopifyTest:shopify] validationError=', validationError.slice(0, 80));
            return { success: false, message: validationError, code: 'INVALID_TOKEN_OR_DOMAIN' };
        }
        const urlRaw = config.shopifyStoreUrl.trim();
        const token = config.shopifyAdminToken.trim();
        const { url, isCustomDomain } = normalizeStoreUrl(urlRaw);
        if (DEBUG)
            console.debug('[ShopifyTest:shopify] normalizedUrl=', url, 'isCustomDomain=', isCustomDomain, 'tokenMask=', maskToken(token));
        if (isCustomDomain) {
            if (DEBUG)
                console.debug('[ShopifyTest:shopify] customDomain=true url=', url);
            return {
                success: false,
                message: 'Please enter your Shopify myshopify.com admin domain. Custom domains are not supported for the Admin API.',
                code: 'INVALID_TOKEN_OR_DOMAIN',
            };
        }
        const shopUrl = `${url}/admin/api/${SHOPIFY_API_VERSION}/shop.json`;
        if (DEBUG)
            console.debug('[ShopifyTest:shopify] targetEndpoint=', shopUrl);
        try {
            const res = await fetch(shopUrl, {
                method: 'GET',
                headers: {
                    'X-Shopify-Access-Token': token,
                    'Content-Type': 'application/json',
                },
            });
            if (DEBUG)
                console.debug('[ShopifyTest:shopify] responseStatus=', res.status, 'ok=', res.ok);
            if (!res.ok) {
                const text = await res.text();
                if (DEBUG)
                    console.debug('[ShopifyTest:shopify] errorBody=', text.slice(0, 120));
                const message = this.messageFromStatus(res.status, text);
                return { success: false, message, code: 'INVALID_TOKEN_OR_DOMAIN' };
            }
            let data;
            try {
                const raw = await res.text();
                if (DEBUG)
                    console.debug('[ShopifyTest:shopify] successBodyLen=', raw.length);
                data = JSON.parse(raw);
            }
            catch (parseErr) {
                if (DEBUG)
                    console.debug('[ShopifyTest:shopify] jsonParseFailed', parseErr);
                return { success: false, message: 'Shopify returned a response that could not be read.', code: 'INVALID_TOKEN_OR_DOMAIN' };
            }
            const shop = data?.shop;
            const shopName = shop?.name ?? 'your store';
            if (DEBUG)
                console.debug('[ShopifyTest:shopify] success shopName=', shopName);
            return {
                success: true,
                message: 'Shopify connection successful',
                shop: shop ? { name: shop.name, domain: shop.domain, email: shop.email } : undefined,
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (DEBUG)
                console.debug('[ShopifyTest:shopify] fetchThrow', message);
            if (message.includes('fetch failed') || message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
                return { success: false, message: 'Could not reach Shopify. Check the store URL and your network.', code: 'INVALID_TOKEN_OR_DOMAIN' };
            }
            return { success: false, message: `Connection failed: ${message}`, code: 'INVALID_TOKEN_OR_DOMAIN' };
        }
    }
    messageFromStatus(status, body) {
        const preview = body.slice(0, 150).replace(/\s+/g, ' ');
        if (status === 401) {
            return 'Invalid Shopify admin access token. Check the token in Shopify Admin → Apps → Develop apps.';
        }
        if (status === 403) {
            return 'Access forbidden. This token may not have permission to read shop details.';
        }
        if (status === 404) {
            return 'Store not found. Use your store’s myshopify.com URL (e.g. https://your-store.myshopify.com).';
        }
        if (status >= 500) {
            return 'Shopify is temporarily unavailable. Try again in a few minutes.';
        }
        return `Shopify API returned ${status}. ${preview || 'Request was rejected.'}`;
    }
};
exports.ShopifyConnectionTestService = ShopifyConnectionTestService;
exports.ShopifyConnectionTestService = ShopifyConnectionTestService = __decorate([
    (0, common_1.Injectable)()
], ShopifyConnectionTestService);
//# sourceMappingURL=shopify-connection-test.service.js.map