import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { ShopifyDraftOrderService } from '../integrations/shopify/draft-order';
import { ShopifyCheckoutValidationError } from '../integrations/shopify/shopify-errors';
import { PaymentLinkDeliveryService } from '../delivery/payment-link-delivery.service';
import { VoicePaymentCatalogService } from './voice-payment-catalog.service';
import type { SendPaymentLinkResponseDto } from './dto/send-payment-link.dto';

@Injectable()
export class VoicePaymentService {
  private readonly logger = new Logger(VoicePaymentService.name);

  constructor(
    private readonly draftOrders: ShopifyDraftOrderService,
    private readonly paymentDelivery: PaymentLinkDeliveryService,
    private readonly catalog: VoicePaymentCatalogService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async sendPaymentLink(args: {
    email: string;
    variantId: string;
    quantity: number;
    phoneNumber?: string;
    callSid?: string;
    tenantId?: string;
    agentId?: string;
  }): Promise<SendPaymentLinkResponseDto> {
    const started = Date.now();
    const email = args.email.trim().toLowerCase();
    const variantId = args.variantId.trim();
    const quantity = args.quantity;
    const phoneNumber = args.phoneNumber?.trim();
    const callSid = args.callSid?.trim();

    this.logger.log(
      JSON.stringify({
        event: 'voice.payment.started',
        emailDomain: email.split('@')[1] ?? null,
        variantId: variantId.slice(0, 80),
        quantity,
        smsRequested: Boolean(phoneNumber),
        callSid: callSid ?? null,
      }),
    );

    try {
      const { tenantId, agentId } = await this.resolveAgentContext(args.tenantId, args.agentId);
      const lineItem = await this.catalog.resolveLineItem(tenantId, agentId, variantId, quantity);

      const shopify = await this.draftOrders.sendDraftOrderPaymentLink(tenantId, agentId, {
        email,
        variantId,
        quantity,
      });

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.draft_order_created',
          tenantId,
          agentId,
          draftOrderId: shopify.draftOrderId,
          invoiceUrlPresent: Boolean(shopify.invoiceUrl),
        }),
      );

      if (shopify.shopifyInvoiceSent) {
        this.logger.log(
          JSON.stringify({
            event: 'voice.payment.shopify_invoice_sent',
            tenantId,
            agentId,
            draftOrderId: shopify.draftOrderId,
            emailDomain: email.split('@')[1] ?? null,
          }),
        );
      } else {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.payment.shopify_invoice_skipped',
            tenantId,
            agentId,
            draftOrderId: shopify.draftOrderId,
            shopifyInvoiceError: shopify.shopifyInvoiceError?.slice(0, 300) ?? null,
          }),
        );
      }

      const checkoutLink = await this.persistCheckoutLink({
        tenantId,
        agentId,
        email,
        invoiceUrl: shopify.invoiceUrl,
        draftOrderId: shopify.draftOrderId,
        shopifyConnectionId: shopify.shopifyConnectionId,
        lineItem,
        callSid,
      });

      const branding = await this.resolveBusinessBranding(tenantId, agentId);

      const delivery = await this.paymentDelivery.deliverPaymentLink({
        customerEmail: email,
        customerPhone: phoneNumber,
        paymentLink: shopify.invoiceUrl,
        callSid,
        orderId: shopify.draftOrderId,
        tenantId,
        agentId,
        businessName: branding.businessName,
        supportEmail: branding.supportEmail,
        supportPhone: branding.supportPhone,
        lineItems: [
          {
            title: lineItem.title,
            quantity: lineItem.quantity,
            price: lineItem.price,
          },
        ],
      });

      const emailSentByResend = delivery.email === 'sent';
      const smsSent = delivery.sms === 'sent';
      const whatsappSent = delivery.whatsapp === 'sent';
      const emailSentByShopify = shopify.shopifyInvoiceSent;
      const warnings: string[] = [];

      if (emailSentByResend) {
        await this.prisma.checkoutLink.update({
          where: { id: checkoutLink.id },
          data: { status: 'SENT', sentAt: new Date() },
        });
      }

      if (!emailSentByResend && delivery.emailError) {
        warnings.push(`Email delivery failed: ${delivery.emailError}`);
      }
      if (delivery.sms === 'failed' && delivery.smsError) {
        warnings.push(`SMS failed: ${delivery.smsError}`);
      }
      if (delivery.whatsapp === 'failed' && delivery.whatsappError) {
        warnings.push(`WhatsApp failed: ${delivery.whatsappError}`);
      }

      const emailDelivered = emailSentByShopify || emailSentByResend;
      const latencyMs = Date.now() - started;

      if (!emailDelivered && !smsSent && !whatsappSent) {
        const error =
          'Payment link was created but could not be delivered by email or messaging.';
        this.logger.error(
          JSON.stringify({
            event: 'voice.payment.failed',
            tenantId,
            agentId,
            draftOrderId: shopify.draftOrderId,
            deliveryId: delivery.deliveryId,
            emailSentByShopify,
            emailSentByResend,
            smsSent,
            whatsappSent,
            latencyMs,
          }),
        );
        return {
          success: false,
          message: 'Payment link could not be delivered.',
          agentMessage: delivery.agentMessage,
          error,
          draftOrderId: shopify.draftOrderId,
          invoiceUrl: shopify.invoiceUrl,
          emailSentByShopify,
          emailSentByResend,
          smsSent,
          whatsappSent,
          delivery,
          latencyMs,
        };
      }

      if (emailSentByShopify && !emailSentByResend) {
        warnings.push('Backup payment email was not delivered; customer may rely on store invoice email.');
      }

      const warning = warnings.length > 0 ? warnings.join(' ') : undefined;

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.completed',
          tenantId,
          agentId,
          draftOrderId: shopify.draftOrderId,
          deliveryId: delivery.deliveryId,
          emailSentByShopify,
          emailSentByResend,
          smsSent,
          whatsappSent,
          latencyMs,
        }),
      );

      return {
        success: true,
        message: warning ? 'Payment link sent with delivery warnings.' : 'Payment link sent successfully.',
        agentMessage: delivery.agentMessage,
        draftOrderId: shopify.draftOrderId,
        invoiceUrl: shopify.invoiceUrl,
        emailSentByShopify,
        emailSentByResend,
        smsSent,
        whatsappSent,
        delivery: {
          email: delivery.email,
          sms: delivery.sms,
          whatsapp: delivery.whatsapp,
        },
        warning,
        latencyMs,
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
        agentMessage:
          "I created your payment link, but I'm having trouble sending the email. Please confirm your email again.",
        error: message,
        emailSentByShopify: false,
        emailSentByResend: false,
        smsSent: false,
        whatsappSent: false,
        latencyMs: Date.now() - started,
      };
    }
  }

  private async persistCheckoutLink(args: {
    tenantId: string;
    agentId: string;
    email: string;
    invoiceUrl: string;
    draftOrderId: string;
    shopifyConnectionId: string | null;
    lineItem: { title: string; quantity: number; price: string | null; variantId: string };
    callSid?: string;
  }) {
    const fingerprint = createHash('sha256')
      .update(
        [
          args.tenantId,
          args.agentId,
          args.draftOrderId,
          args.email,
          args.lineItem.variantId,
          String(args.lineItem.quantity),
        ].join('|'),
        'utf8',
      )
      .digest('hex');

    let callSessionId: string | undefined;
    if (args.callSid) {
      const session = await this.prisma.callSession.findFirst({
        where: { twilioCallSid: args.callSid },
        select: { id: true },
      });
      callSessionId = session?.id;
    }

    return this.prisma.checkoutLink.create({
      data: {
        tenantId: args.tenantId,
        agentId: args.agentId,
        callSessionId,
        checkoutFingerprint: fingerprint,
        shopifyConnectionId: args.shopifyConnectionId,
        mode: 'DRAFT_ORDER_INVOICE',
        checkoutUrl: args.invoiceUrl,
        customerEmail: args.email,
        itemsJson: [
          {
            title: args.lineItem.title,
            quantity: args.lineItem.quantity,
            price: args.lineItem.price,
            variantId: args.lineItem.variantId,
          },
        ] as unknown as Prisma.InputJsonValue,
        providerRef: args.draftOrderId,
        status: 'CREATED',
        metadata: {
          source: 'voice_send_payment_link',
          draftOrderId: args.draftOrderId,
          callSid: args.callSid ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }

  private async resolveBusinessBranding(
    tenantId: string,
    agentId: string,
  ): Promise<{
    businessName: string;
    supportEmail: string | null;
    supportPhone: string | null;
  }> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: {
        agentConfig: {
          select: { businessName: true, supportEmail: true, supportPhone: true },
        },
        client: { select: { name: true, contactEmail: true, contactPhone: true } },
      },
    });

    return {
      businessName:
        agent?.agentConfig?.businessName?.trim() ||
        agent?.client?.name?.trim() ||
        'SureShot Books',
      supportEmail: agent?.agentConfig?.supportEmail ?? agent?.client?.contactEmail ?? null,
      supportPhone: agent?.agentConfig?.supportPhone ?? agent?.client?.contactPhone ?? null,
    };
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
