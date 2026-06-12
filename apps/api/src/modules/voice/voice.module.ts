import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { AgentsModule } from '../agents/agents.module';
import { EmailModule } from '../integrations/email/email.module';
import { ShopifyVoiceModule } from '../shopify/shopify-voice.module';
import { VoiceCatalogSearchModule } from '../search/voice-catalog-search.module';
import { VoiceCheckoutModule } from '../checkout/checkout.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { InboundCallModule } from '../delivery/inbound-call.module';
import { VoiceCallContextService } from './voice-call-context.service';
import { VoiceSearchController } from './voice-search.controller';
import { VoicePaymentController } from './voice-payment.controller';
import { VoiceOrderController } from './voice-order.controller';
import { VoiceHealthController } from './voice-health.controller';
import { VoiceSearchService } from './voice-search.service';
import { VoicePaymentService } from './voice-payment.service';
import { VoiceOrderService } from './voice-order.service';
import { VoicePaymentCatalogService } from './voice-payment-catalog.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';

/**
 * ElevenLabs ConvAI server tools (search, send-payment-link).
 * Does not import TelephonyModule — that pulled TwilioModule → ElevenLabsModule into the
 * same graph as DeliveryModule and caused circular bootstrap failures.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AgentsModule,
    EmailModule,
    ShopifyVoiceModule,
    VoiceCatalogSearchModule,
    VoiceCheckoutModule,
    DeliveryModule,
    InboundCallModule,
  ],
  controllers: [VoiceSearchController, VoicePaymentController, VoiceOrderController, VoiceHealthController],
  providers: [
    VoiceSearchService,
    VoicePaymentService,
    VoiceOrderService,
    VoicePaymentCatalogService,
    VoiceCallContextService,
    VoiceApiKeyGuard,
  ],
  exports: [VoiceSearchService, VoicePaymentService, VoiceOrderService],
})
export class VoiceModule {}
