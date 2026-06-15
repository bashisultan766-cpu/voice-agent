import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { GetOrderQueryDto } from './dto/get-order.dto';
import { VoiceOrderService } from './voice-order.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';
import { flattenElevenLabsToolBody, resolvePhoneNumberFromToolBody } from './utils/parse-elevenlabs-tool-body.util';
import { resolveVoiceOrderQuery } from './utils/resolve-voice-order-query.util';

/**
 * Order lookup for ElevenLabs Conversational AI server tools.
 * GET  /api/voice/get-order
 * POST /api/voice/get-order
 */
@Controller('voice')
export class VoiceOrderController {
  constructor(private readonly voiceOrder: VoiceOrderService) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Get('get-order')
  getOrder(@Query() query: GetOrderQueryDto) {
    const orderNumber = resolveVoiceOrderQuery(query);
    if (!orderNumber) {
      throw new BadRequestException(
        'order_number is required (or orderNumber, order, name, query). Example: ?order_number=1010',
      );
    }
    return this.voiceOrder.getOrder({
      orderNumber,
      tenantId: query.tenantId,
      agentId: query.agentId,
      callerPhone: query.callerPhone ?? query.caller_phone,
    });
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('get-order')
  postGetOrder(@Body() body: GetOrderQueryDto & Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const orderNumber = resolveVoiceOrderQuery(flat) ?? resolveVoiceOrderQuery(body);
    if (!orderNumber) {
      throw new BadRequestException(
        'order_number is required in the tool body (orderNumber, order, name, or query also accepted).',
      );
    }
    const tenantId =
      (typeof flat.tenantId === 'string' && flat.tenantId) ||
      (typeof flat.tenant_id === 'string' && flat.tenant_id) ||
      body.tenantId;
    const agentId =
      (typeof flat.agentId === 'string' && flat.agentId) ||
      (typeof flat.agent_id === 'string' && flat.agent_id) ||
      body.agentId;
    const callerPhone =
      resolvePhoneNumberFromToolBody(body) ||
      (typeof flat.callerPhone === 'string' && flat.callerPhone) ||
      (typeof flat.caller_phone === 'string' && flat.caller_phone) ||
      (typeof body.callerPhone === 'string' && body.callerPhone) ||
      (typeof body.caller_phone === 'string' && body.caller_phone);

    return this.voiceOrder.getOrder({
      orderNumber,
      tenantId: typeof tenantId === 'string' ? tenantId : undefined,
      agentId: typeof agentId === 'string' ? agentId : undefined,
      callerPhone: typeof callerPhone === 'string' ? callerPhone : undefined,
    });
  }
}
