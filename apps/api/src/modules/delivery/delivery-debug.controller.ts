import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { VoiceApiKeyGuard } from '../voice/guards/voice-api-key.guard';
import { PaymentLinkDeliveryService } from './payment-link-delivery.service';
import { DeliveryDebugGuard } from './guards/delivery-debug.guard';
import { TestDeliveryDto } from './dto/test-delivery.dto';
import { PrismaService } from '../../database/prisma.service';

@Controller('debug')
export class DeliveryDebugController {
  constructor(
    private readonly delivery: PaymentLinkDeliveryService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @SkipThrottle()
  @UseGuards(DeliveryDebugGuard, VoiceApiKeyGuard)
  @Get('payment-deliveries/latest')
  async latestDeliveries() {
    const rows = await this.prisma.paymentDelivery.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return { count: rows.length, records: rows };
  }

  @Public()
  @SkipThrottle()
  @UseGuards(DeliveryDebugGuard, VoiceApiKeyGuard)
  @Post('test-delivery')
  async testDelivery(@Body() dto: TestDeliveryDto) {
    const result = await this.delivery.deliverPaymentLink({
      customerEmail: dto.email,
      customerPhone: dto.phone,
      paymentLink: dto.paymentLink,
      callSid: dto.callSid,
      tenantId: dto.tenantId,
      agentId: dto.agentId,
      businessName: 'SureShot Books',
      lineItems: [{ title: 'Delivery test', quantity: 1, price: null }],
    });

    return {
      ok: result.email === 'sent' || result.sms === 'sent' || result.whatsapp === 'sent',
      deliveryId: result.deliveryId,
      email: result.email,
      sms: result.sms,
      whatsapp: result.whatsapp,
      agentMessage: result.agentMessage,
    };
  }
}
