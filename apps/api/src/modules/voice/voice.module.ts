import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { ShopifyVoiceModule } from '../shopify/shopify-voice.module';
import { VoiceCatalogSearchModule } from '../search/voice-catalog-search.module';
import { VoiceSearchController } from './voice-search.controller';
import { VoiceHealthController } from './voice-health.controller';
import { VoiceSearchService } from './voice-search.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';

@Module({
  imports: [ConfigModule, PrismaModule, ShopifyVoiceModule, VoiceCatalogSearchModule],
  controllers: [VoiceSearchController, VoiceHealthController],
  providers: [VoiceSearchService, VoiceApiKeyGuard],
  exports: [VoiceSearchService],
})
export class VoiceModule {}
