import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { BookstoreProductIndexService } from './bookstore-product-index.service';
import { BookstoreSearchCacheService } from './bookstore-search-cache.service';
import { BookstoreVoiceSearchService } from './bookstore-voice-search.service';
import { BookstoreSearchWarmService } from './bookstore-search-warm.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    BookstoreSearchCacheService,
    BookstoreProductIndexService,
    BookstoreVoiceSearchService,
    BookstoreSearchWarmService,
  ],
  exports: [BookstoreVoiceSearchService, BookstoreSearchCacheService, BookstoreProductIndexService],
})
export class BookstoreSearchModule {}
