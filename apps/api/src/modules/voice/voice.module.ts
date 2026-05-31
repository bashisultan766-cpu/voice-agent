import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { AgentsModule } from '../agents/agents.module';
import { EmailModule } from '../integrations/email/email.module';
import { ShopifyVoiceModule } from '../shopify/shopify-voice.module';
import { VoiceCatalogSearchModule } from '../search/voice-catalog-search.module';
import { VoiceCheckoutModule } from '../checkout/checkout.module';
import { TelephonyModule } from '../telephony/telephony.module';
import { VoiceSearchController } from './voice-search.controller';
import { VoicePaymentController } from './voice-payment.controller';
import { VoiceHealthController } from './voice-health.controller';
import { VoiceSearchService } from './voice-search.service';
import { VoicePaymentService } from './voice-payment.service';
import { VoicePaymentDeliveryService } from './voice-payment-delivery.service';
import { VoicePaymentCatalogService } from './voice-payment-catalog.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AgentsModule,
    EmailModule,
    ShopifyVoiceModule,
    VoiceCatalogSearchModule,
    VoiceCheckoutModule,
    TelephonyModule,
  ],
  controllers: [VoiceSearchController, VoicePaymentController, VoiceHealthController],
  providers: [
    VoiceSearchService,
    VoicePaymentService,
    VoicePaymentDeliveryService,
    VoicePaymentCatalogService,
    VoiceApiKeyGuard,
  ],
  exports: [VoiceSearchService, VoicePaymentService],
})
export class VoiceModule {}
