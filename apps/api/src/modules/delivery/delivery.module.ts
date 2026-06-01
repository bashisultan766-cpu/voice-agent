import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { AgentsModule } from '../agents/agents.module';
import { EmailModule } from '../integrations/email/email.module';
import { TwilioMessagingModule } from '../integrations/twilio/twilio-messaging.module';
import { InboundCallModule } from './inbound-call.module';
import { EmailDeliveryService } from './email-delivery.service';
import { TwilioPaymentSmsService } from './twilio-payment-sms.service';
import { TwilioWhatsAppService } from './twilio-whatsapp.service';
import { PaymentLinkDeliveryService } from './payment-link-delivery.service';
import { DeliveryDebugController } from './delivery-debug.controller';
import { DeliveryDebugGuard } from './guards/delivery-debug.guard';
import { VoiceApiKeyGuard } from '../voice/guards/voice-api-key.guard';

/**
 * Multi-channel payment link delivery (email, SMS, WhatsApp).
 *
 * Must be imported by AppModule (see app.module.ts) so DeliveryDebugController routes register:
 *   GET  /api/debug/payment-deliveries/latest
 *   POST /api/debug/test-delivery
 *
 * Also imported by VoiceModule for PaymentLinkDeliveryService. Nest dedupes the module instance.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AgentsModule,
    EmailModule,
    TwilioMessagingModule,
    InboundCallModule,
  ],
  controllers: [DeliveryDebugController],
  providers: [
    EmailDeliveryService,
    TwilioPaymentSmsService,
    TwilioWhatsAppService,
    PaymentLinkDeliveryService,
    DeliveryDebugGuard,
    VoiceApiKeyGuard,
  ],
  exports: [
    EmailDeliveryService,
    TwilioPaymentSmsService,
    TwilioWhatsAppService,
    PaymentLinkDeliveryService,
    InboundCallModule,
  ],
})
export class DeliveryModule {}
