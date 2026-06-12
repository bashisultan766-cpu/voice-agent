import { Module } from '@nestjs/common';
import { TwilioModule } from './twilio/twilio.module';
import { ElevenLabsModule } from './elevenlabs/elevenlabs.module';
import { ShopifyModule } from './shopify/shopify.module';
import { EmailModule } from './email/email.module';
import { CallerIdentityModule } from './caller-identity/caller-identity.module';

@Module({
  imports: [TwilioModule, ElevenLabsModule, ShopifyModule, EmailModule, CallerIdentityModule],
})
export class IntegrationsModule {}
