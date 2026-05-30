import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { CommonModule } from '../../common/common.module';
import { ShopifyClientService } from '../integrations/shopify/client';
import { ShopifySearchService } from './shopify-search.service';

@Module({
  imports: [PrismaModule, CommonModule],
  providers: [ShopifyClientService, ShopifySearchService],
  exports: [ShopifySearchService, ShopifyClientService],
})
export class ShopifyVoiceModule {}
