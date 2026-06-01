import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { AgentsModule } from '../agents/agents.module';
import { TwilioMessagingModule } from '../integrations/twilio/twilio-messaging.module';
import { InboundCallModule } from './inbound-call.module';
import { EmailDeliveryService } from './email-delivery.service';
import { TwilioPaymentSmsService } from './twilio-payment-sms.service';
import { TwilioWhatsAppService } from './twilio-whatsapp.service';
import { PaymentLinkDeliveryService } from './payment-link-delivery.service';

/**
 * Multi-channel payment link delivery (email, SMS, WhatsApp).
 *
 * Previously imported TwilioModule (index [3]), which re-imported ElevenLabsModule → DeliveryModule
 * and left TwilioModule undefined at bootstrap. TwilioMessagingModule breaks that cycle.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AgentsModule,
    TwilioMessagingModule,
    InboundCallModule,
  ],
  providers: [EmailDeliveryService, TwilioPaymentSmsService, TwilioWhatsAppService, PaymentLinkDeliveryService],
  exports: [
    EmailDeliveryService,
    TwilioPaymentSmsService,
    TwilioWhatsAppService,
    PaymentLinkDeliveryService,
    InboundCallModule,
  ],
})
export class DeliveryModule {}
