import { Module } from '@nestjs/common';
import { TwilioModule } from './twilio/twilio.module';
import { ElevenLabsModule } from './elevenlabs/elevenlabs.module';
import { ShopifyModule } from './shopify/shopify.module';
import { EmailModule } from './email/email.module';

@Module({
  imports: [TwilioModule, ElevenLabsModule, ShopifyModule, EmailModule],
})
export class IntegrationsModule {}
