import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { SearchProductDto } from './dto/search-product.dto';
import { GetProductQueryDto } from './dto/get-product-query.dto';
import { VoiceSearchService } from './voice-search.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';
import { resolveVoiceProductQuery } from './utils/resolve-voice-product-query.util';
import type { SearchProductResponseDto } from './dto/search-product.dto';

/**
 * Ultra-fast product search for ElevenLabs Conversational AI server tools.
 * POST /api/voice/search-product
 * GET  /api/voice/get-product (SureShotBooksProductFetcher)
 */
@Controller('voice')
export class VoiceSearchController {
  constructor(private readonly voiceSearch: VoiceSearchService) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('search-product')
  searchProduct(@Body() dto: SearchProductDto) {
    return this.voiceSearch.searchProduct({
      query: dto.query,
      tenantId: dto.tenantId,
      agentId: dto.agentId,
      limit: dto.limit,
    });
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Get('get-product')
  async getProduct(@Query() query: GetProductQueryDto) {
    const resolved = resolveVoiceProductQuery(query);
    if (!resolved) {
      throw new BadRequestException(
        'query is required (or isbn, sku, search, q). Example: ?query=9780143127550&limit=5',
      );
    }

    const result = await this.voiceSearch.searchProduct({
      query: resolved,
      tenantId: query.tenantId,
      agentId: query.agentId,
      limit: query.limit,
    });

    return mapGetProductResponse(result);
  }
}

/** Adds quantity alias for ElevenLabs ProductFetcher tool docs. */
export function mapGetProductResponse(result: SearchProductResponseDto) {
  return {
    ...result,
    products: result.products.map((p) => ({
      ...p,
      quantity: p.inventory,
    })),
  };
}
