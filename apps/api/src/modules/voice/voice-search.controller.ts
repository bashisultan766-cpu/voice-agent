import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { SearchProductDto } from './dto/search-product.dto';
import { VoiceSearchService } from './voice-search.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';

/**
 * Ultra-fast product search for ElevenLabs Conversational AI server tools.
 * POST /api/voice/search-product
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
}
