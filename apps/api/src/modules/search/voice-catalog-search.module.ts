import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VoiceProductCacheService } from './voice-product-cache.service';

@Module({
  imports: [ConfigModule],
  providers: [VoiceProductCacheService],
  exports: [VoiceProductCacheService],
})
export class VoiceCatalogSearchModule {}
