import { Controller, Get, Param } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { AgentsService } from './agents.service';

@Public()
@SkipThrottle()
@Controller('public/agents')
export class PublicAgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  /** Safe, shareable facts for a customer-facing page (no secrets). */
  @Get(':id')
  liveCard(@Param('id') id: string) {
    return this.agentsService.getPublicLiveCard(id);
  }
}
