import { Controller, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators/public.decorator';
import { VoiceApiKeyGuard } from '../../voice/guards/voice-api-key.guard';
import { ThreeCxCallerService } from './three-cx-caller.service';

/**
 * Deployment health — verify live 3CX API credentials on VPS.
 * GET /api/integrations/3cx/status
 */
@Controller('integrations/3cx')
export class ThreeCxStatusController {
  constructor(private readonly threeCxCaller: ThreeCxCallerService) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Get('status')
  status() {
    return this.threeCxCaller.getIntegrationStatus();
  }
}
