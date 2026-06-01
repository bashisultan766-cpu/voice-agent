import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { AgentsModule } from '../agents/agents.module';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { EmailDeliveryService } from './email-delivery.service';
import { TwilioPaymentSmsService } from './twilio-payment-sms.service';
import { TwilioWhatsAppService } from './twilio-whatsapp.service';
import { InboundCallCaptureService } from './inbound-call-capture.service';
import { PaymentLinkDeliveryService } from './payment-link-delivery.service';

@Module({
  imports: [ConfigModule, PrismaModule, AgentsModule, TwilioModule],
  providers: [
    EmailDeliveryService,
    TwilioPaymentSmsService,
    TwilioWhatsAppService,
    InboundCallCaptureService,
    PaymentLinkDeliveryService,
  ],
  exports: [
    EmailDeliveryService,
    TwilioPaymentSmsService,
    TwilioWhatsAppService,
    InboundCallCaptureService,
    PaymentLinkDeliveryService,
  ],
})
export class DeliveryModule {}
