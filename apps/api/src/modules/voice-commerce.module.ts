import { Module } from '@nestjs/common';
import { VoiceModule } from './voice/voice.module';
import { ShopifyVoiceModule } from './shopify/shopify-voice.module';
import { VoiceCatalogSearchModule } from './search/voice-catalog-search.module';
import { VoiceCheckoutModule } from './checkout/checkout.module';
import { TelephonyModule } from './telephony/telephony.module';

/**
 * 2026 realtime voice commerce stack:
 * Twilio → ElevenLabs → Voice API → Shopify GraphQL → Redis cache
 */
@Module({
  imports: [
    ShopifyVoiceModule,
    VoiceCatalogSearchModule,
    VoiceModule,
    VoiceCheckoutModule,
    TelephonyModule,
  ],
  exports: [VoiceModule, ShopifyVoiceModule, VoiceCatalogSearchModule, VoiceCheckoutModule, TelephonyModule],
})
export class VoiceCommerceModule {}
