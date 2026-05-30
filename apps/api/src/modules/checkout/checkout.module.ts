import { Module } from '@nestjs/common';
import { ShopifyModule } from '../integrations/shopify/shopify.module';

/**
 * Voice checkout surface — re-exports Shopify draft/cart checkout services.
 */
@Module({
  imports: [ShopifyModule],
  exports: [ShopifyModule],
})
export class VoiceCheckoutModule {}
