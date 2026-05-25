import { Controller, Get, Param, Post, Query, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { VoiceRuntimeService } from './voice-runtime.service';
import { VoiceLiveMonitorService } from './voice-live-monitor.service';
import { Roles } from '../../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { greetingQuerySchema, turnBodySchema } from './voice-runtime.schema';
import { cuidParamSchema } from '../../ops/ops-validation';
import type { z } from 'zod';

/**
 * HTTP endpoints for runtime context and turn processing.
 * Twilio Media Streams / ConversationRelay use WebSocket in production;
 * this allows testing and server-to-server turn handling.
 */
@Controller('calls/runtime')
@Roles(UserRole.MANAGER)
export class VoiceRuntimeController {
  constructor(
    private readonly runtime: VoiceRuntimeService,
    private readonly liveMonitor: VoiceLiveMonitorService,
  ) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('greeting')
  async getGreeting(
    @Query(new ZodValidationPipe(greetingQuerySchema)) query: z.infer<typeof greetingQuerySchema>,
  ) {
    const text = await this.runtime.getGreeting(query.callSessionId);
    return { greeting: text };
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('session/:callSessionId/context')
  async getContext(
    @Param('callSessionId', new ZodValidationPipe(cuidParamSchema)) callSessionId: string,
  ) {
    const greeting = await this.runtime.getGreeting(callSessionId);
    const systemPrompt = await this.runtime.buildSystemPrompt(callSessionId);
    return { greeting, systemPrompt };
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('live-monitor')
  async getLiveMonitor(
    @Query(new ZodValidationPipe(greetingQuerySchema)) query: z.infer<typeof greetingQuerySchema>,
  ) {
    const snap = await this.liveMonitor.snapshot(query.callSessionId);
    if (!snap) return { ok: false, message: 'Call session not found' };
    return { ok: true, ...snap };
  }

  @Throttle({ default: { limit: Number(process.env.API_RATE_LIMIT_SENSITIVE_MAX) || 40, ttl: 60_000 } })
  @Post('turn')
  async processTurn(
    @Body(new ZodValidationPipe(turnBodySchema)) body: z.infer<typeof turnBodySchema>,
  ) {
    const { callSessionId, message, history = [] } = body;
    const { reply } = await this.runtime.processUtterance(callSessionId, message, history);
    return { reply };
  }
}
