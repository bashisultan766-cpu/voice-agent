"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyModule = void 0;
const common_1 = require("@nestjs/common");
const shopify_controller_1 = require("./shopify.controller");
const shopify_service_1 = require("./shopify.service");
const agents_module_1 = require("../../agents/agents.module");
const shopify_checkout_service_1 = require("./shopify-checkout.service");
const client_1 = require("./client");
const product_sync_1 = require("./product-sync");
const product_search_1 = require("./product-search");
const cart_checkout_1 = require("./cart-checkout");
const draft_order_1 = require("./draft-order");
const product_sync_queue_1 = require("./product-sync.queue");
let ShopifyModule = class ShopifyModule {
};
exports.ShopifyModule = ShopifyModule;
exports.ShopifyModule = ShopifyModule = __decorate([
    (0, common_1.Module)({
        imports: [agents_module_1.AgentsModule],
        controllers: [shopify_controller_1.ShopifyController],
        providers: [
            shopify_service_1.ShopifyService,
            shopify_checkout_service_1.ShopifyCheckoutService,
            client_1.ShopifyClientService,
            product_sync_1.ShopifyProductSyncService,
            product_search_1.ShopifyProductSearchService,
            cart_checkout_1.ShopifyCartCheckoutService,
            draft_order_1.ShopifyDraftOrderService,
            product_sync_queue_1.ShopifyProductSyncQueueService,
        ],
        exports: [
            shopify_checkout_service_1.ShopifyCheckoutService,
            shopify_service_1.ShopifyService,
            client_1.ShopifyClientService,
            product_sync_1.ShopifyProductSyncService,
            product_search_1.ShopifyProductSearchService,
            cart_checkout_1.ShopifyCartCheckoutService,
            draft_order_1.ShopifyDraftOrderService,
            product_sync_queue_1.ShopifyProductSyncQueueService,
        ],
    })
], ShopifyModule);
//# sourceMappingURL=shopify.module.js.map