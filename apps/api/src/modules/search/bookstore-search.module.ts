import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { AgentsModule } from '../agents/agents.module';
import { BookstoreProductIndexService } from './bookstore-product-index.service';
import { BookstoreSearchCacheService } from './bookstore-search-cache.service';
import { BookstoreVoiceSearchService } from './bookstore-voice-search.service';
import { BookstoreSearchWarmService } from './bookstore-search-warm.service';
import { RealtimeSearchSyncService } from './realtime/realtime-search-sync.service';
import { RealtimeVoiceProductSearchService } from './realtime/realtime-voice-product-search.service';
import { ShopifyProductSyncQueueService } from '../integrations/shopify/product-sync.queue';

@Module({
  imports: [ConfigModule, PrismaModule, forwardRef(() => AgentsModule)],
  providers: [
    BookstoreSearchCacheService,
    BookstoreProductIndexService,
    BookstoreVoiceSearchService,
    BookstoreSearchWarmService,
    RealtimeSearchSyncService,
    RealtimeVoiceProductSearchService,
    ShopifyProductSyncQueueService,
  ],
  exports: [
    BookstoreVoiceSearchService,
    BookstoreSearchCacheService,
    BookstoreProductIndexService,
    RealtimeVoiceProductSearchService,
    RealtimeSearchSyncService,
  ],
})
export class BookstoreSearchModule {}
