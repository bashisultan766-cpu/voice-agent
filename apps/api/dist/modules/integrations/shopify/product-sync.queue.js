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
exports.ShopifyProductSyncQueueService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const bullmq_1 = require("bullmq");
let ShopifyProductSyncQueueService = class ShopifyProductSyncQueueService {
    constructor(config) {
        this.config = config;
        this.queue = null;
    }
    getQueue() {
        if (this.queue)
            return this.queue;
        const connection = this.config.get('REDIS_URL')?.trim();
        if (!connection)
            throw new Error('REDIS_URL is not configured for product sync queue.');
        this.queue = new bullmq_1.Queue('shopify-product-sync', { connection: { url: connection } });
        return this.queue;
    }
    async enqueue(tenantId, agentId) {
        const queue = this.getQueue();
        await queue.add('sync-products', { tenantId, agentId }, {
            removeOnComplete: 50,
            removeOnFail: 100,
            attempts: 5,
            backoff: { type: 'exponential', delay: 3000 },
        });
    }
};
exports.ShopifyProductSyncQueueService = ShopifyProductSyncQueueService;
exports.ShopifyProductSyncQueueService = ShopifyProductSyncQueueService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], ShopifyProductSyncQueueService);
//# sourceMappingURL=product-sync.queue.js.map