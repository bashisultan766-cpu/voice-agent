import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../database/prisma.module';
import { CallerIdentityService } from './caller-identity.service';
import { ShopifyCustomerLookupService } from './shopify-customer-lookup.service';
import { ShopifyClientService } from '../shopify/client';
import { ThreeCxApiClient } from './three-cx-api.client';
import { ThreeCxCallerService } from './three-cx-caller.service';
import { ThreeCxCrmController } from './three-cx-crm.controller';
import { ThreeCxRecordingsController } from './three-cx-recordings.controller';
import { ThreeCxStatusController } from './three-cx-status.controller';
import { CallerIdentityAdminController } from './caller-identity-admin.controller';
import { VoiceApiKeyGuard } from '../../voice/guards/voice-api-key.guard';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [
    ThreeCxCrmController,
    ThreeCxRecordingsController,
    ThreeCxStatusController,
    CallerIdentityAdminController,
  ],
  providers: [
    CallerIdentityService,
    ThreeCxApiClient,
    ThreeCxCallerService,
    ShopifyCustomerLookupService,
    ShopifyClientService,
    VoiceApiKeyGuard,
  ],
  exports: [CallerIdentityService, ThreeCxApiClient, ThreeCxCallerService, ShopifyCustomerLookupService],
})
export class CallerIdentityModule {}
