import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ShopifyDraftOrderService } from '../integrations/shopify/draft-order';
import { ShopifyCheckoutValidationError } from '../integrations/shopify/shopify-errors';
import type { SendPaymentLinkResponseDto } from './dto/send-payment-link.dto';

@Injectable()
export class VoicePaymentService {
  private readonly logger = new Logger(VoicePaymentService.name);

  constructor(
    private readonly draftOrders: ShopifyDraftOrderService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async sendPaymentLink(args: {
    email: string;
    variantId: string;
    quantity: number;
    tenantId?: string;
    agentId?: string;
  }): Promise<SendPaymentLinkResponseDto> {
    const started = Date.now();
    const email = args.email.trim().toLowerCase();
    const variantId = args.variantId.trim();
    const quantity = args.quantity;

    this.logger.log(
      JSON.stringify({
        event: 'voice.payment.started',
        emailDomain: email.split('@')[1] ?? null,
        variantId: variantId.slice(0, 80),
        quantity,
      }),
    );

    try {
      const { tenantId, agentId } = await this.resolveAgentContext(args.tenantId, args.agentId);
      const result = await this.draftOrders.sendDraftOrderPaymentLink(tenantId, agentId, {
        email,
        variantId,
        quantity,
      });

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.draft_order_created',
          tenantId,
          agentId,
          draftOrderId: result.draftOrderId,
          invoiceUrlPresent: Boolean(result.invoiceUrl),
        }),
      );

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.invoice_sent',
          tenantId,
          agentId,
          draftOrderId: result.draftOrderId,
          emailDomain: email.split('@')[1] ?? null,
          latencyMs: Date.now() - started,
        }),
      );

      return {
        success: true,
        message: 'Payment link sent successfully.',
        draftOrderId: result.draftOrderId,
        invoiceUrl: result.invoiceUrl,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const message = this.formatError(err);
      this.logger.error(
        JSON.stringify({
          event: 'voice.payment.failed',
          message: message.slice(0, 400),
          latencyMs: Date.now() - started,
        }),
      );
      return {
        success: false,
        message: 'Payment link could not be sent.',
        error: message,
        latencyMs: Date.now() - started,
      };
    }
  }

  private formatError(err: unknown): string {
    if (err instanceof ShopifyCheckoutValidationError) return err.message;
    if (err instanceof BadRequestException) {
      const res = err.getResponse();
      if (typeof res === 'string') return res;
      if (typeof res === 'object' && res !== null && 'message' in res) {
        const msg = (res as { message?: string | string[] }).message;
        return Array.isArray(msg) ? msg.join('; ') : String(msg ?? err.message);
      }
    }
    return err instanceof Error ? err.message : String(err);
  }

  private async resolveAgentContext(
    tenantId?: string,
    agentId?: string,
  ): Promise<{ tenantId: string; agentId: string }> {
    const envTenant = this.config.get<string>('VOICE_DEFAULT_TENANT_ID')?.trim();
    const envAgent = this.config.get<string>('VOICE_DEFAULT_AGENT_ID')?.trim();

    const resolvedTenant = tenantId?.trim() || envTenant;
    const resolvedAgent = agentId?.trim() || envAgent;

    if (resolvedTenant && resolvedAgent) {
      return { tenantId: resolvedTenant, agentId: resolvedAgent };
    }

    const agent = await this.prisma.agent.findFirst({
      where: { deletedAt: null, status: { in: [AgentStatus.ACTIVE, AgentStatus.READY] } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, tenantId: true },
    });
    if (!agent) {
      throw new BadRequestException(
        'No agent context. Provide tenantId/agentId or set VOICE_DEFAULT_TENANT_ID and VOICE_DEFAULT_AGENT_ID.',
      );
    }
    return { tenantId: resolvedTenant ?? agent.tenantId, agentId: resolvedAgent ?? agent.id };
  }
}
