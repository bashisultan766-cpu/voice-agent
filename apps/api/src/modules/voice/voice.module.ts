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
import { CallerIdentityModule } from '../integrations/caller-identity/caller-identity.module';
import { VoiceCallContextService } from './voice-call-context.service';
import { VoiceSearchController } from './voice-search.controller';
import { VoicePaymentController } from './voice-payment.controller';
import { VoiceOrderController } from './voice-order.controller';
import { VoiceIntentController } from './voice-intent.controller';
import { VoiceHealthController } from './voice-health.controller';
import { VoiceCallerController } from './voice-caller.controller';
import { VoiceGetCallerInfoController } from './voice-get-caller-info.controller';
import { VoiceCommerceController } from './voice-commerce.controller';
import { VoiceSearchService } from './voice-search.service';
import { VoicePaymentService } from './voice-payment.service';
import { VoiceOrderService } from './voice-order.service';
import { VoiceIntentService } from './voice-intent.service';
import { VoiceFacilityLinkService } from './voice-facility-link.service';
import { VoicePaymentCatalogService } from './voice-payment-catalog.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';
import { VoiceDiagnosticsModule } from './voice-diagnostics.module';
import { VoiceAgentContextService } from './services/voice-agent-context.service';
import { VoiceOrderLookupService } from './services/voice-order-lookup.service';
import { VoiceCatalogService } from './services/voice-catalog.service';
import { VoicePricingService } from './services/voice-pricing.service';
import { VoiceShippingService } from './services/voice-shipping.service';
import { FacilityApprovalService } from './services/facility-approval.service';
import { FacilityRestrictionService } from './services/facility-restriction.service';
import { VoiceAddressUpdateService } from './services/voice-address-update.service';
import { VoiceCancellationService } from './services/voice-cancellation.service';
import { VoiceEscalationService } from './services/voice-escalation.service';

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
    CallerIdentityModule,
    VoiceDiagnosticsModule,
  ],
  controllers: [
    VoiceSearchController,
    VoicePaymentController,
    VoiceOrderController,
    VoiceIntentController,
    VoiceHealthController,
    VoiceCallerController,
    VoiceGetCallerInfoController,
    VoiceCommerceController,
  ],
  providers: [
    VoiceSearchService,
    VoicePaymentService,
    VoiceOrderService,
    VoiceIntentService,
    VoiceFacilityLinkService,
    VoicePaymentCatalogService,
    VoiceCallContextService,
    VoiceApiKeyGuard,
    VoiceAgentContextService,
    VoiceOrderLookupService,
    VoiceCatalogService,
    VoicePricingService,
    VoiceShippingService,
    FacilityApprovalService,
    FacilityRestrictionService,
    VoiceAddressUpdateService,
    VoiceCancellationService,
    VoiceEscalationService,
  ],
  exports: [
    VoiceSearchService,
    VoicePaymentService,
    VoiceOrderService,
    VoiceIntentService,
    VoiceDiagnosticsModule,
  ],
})
export class VoiceModule {}
