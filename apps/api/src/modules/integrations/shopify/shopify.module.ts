import { Module } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { ShopifyService } from './shopify.service';
import { AgentsModule } from '../../agents/agents.module';
import { ShopifyCheckoutService } from './shopify-checkout.service';
import { ShopifyClientService } from './client';
import { ShopifyProductSyncService } from './product-sync';
import { ShopifyProductSearchService } from './product-search';
import { ShopifyCartCheckoutService } from './cart-checkout';
import { ShopifyDraftOrderService } from './draft-order';
import { ShopifyProductSyncQueueService } from './product-sync.queue';

@Module({
  imports: [AgentsModule],
  controllers: [ShopifyController],
  providers: [
    ShopifyService,
    ShopifyCheckoutService,
    ShopifyClientService,
    ShopifyProductSyncService,
    ShopifyProductSearchService,
    ShopifyCartCheckoutService,
    ShopifyDraftOrderService,
    ShopifyProductSyncQueueService,
  ],
  exports: [
    ShopifyCheckoutService,
    ShopifyService,
    ShopifyClientService,
    ShopifyProductSyncService,
    ShopifyProductSearchService,
    ShopifyCartCheckoutService,
    ShopifyDraftOrderService,
    ShopifyProductSyncQueueService,
  ],
})
export class ShopifyModule {}

