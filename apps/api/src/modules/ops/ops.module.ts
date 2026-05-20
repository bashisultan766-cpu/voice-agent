import { Module } from '@nestjs/common';
import { OpsService } from './ops.service';
import { OpsController } from './ops.controller';
import { CallsModule } from '../calls/calls.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { EmailModule } from '../integrations/email/email.module';
import { OpenAIConnectionTestService } from '../agents/connection-test/openai-connection-test.service';
import { TwilioConnectionTestService } from '../agents/connection-test/twilio-connection-test.service';

@Module({
  imports: [CallsModule, ShopifyModule, EmailModule],
  providers: [OpsService, OpenAIConnectionTestService, TwilioConnectionTestService],
  controllers: [OpsController],
})
export class OpsModule {}
