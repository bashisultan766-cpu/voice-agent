import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { ShopifyDraftOrderService } from '../integrations/shopify/draft-order';
import { ShopifyCheckoutValidationError } from '../integrations/shopify/shopify-errors';
import { VoicePaymentCatalogService } from './voice-payment-catalog.service';
import { VoicePaymentDeliveryService } from './voice-payment-delivery.service';
import type { SendPaymentLinkResponseDto } from './dto/send-payment-link.dto';

@Injectable()
export class VoicePaymentService {
  private readonly logger = new Logger(VoicePaymentService.name);

  constructor(
    private readonly draftOrders: ShopifyDraftOrderService,
    private readonly delivery: VoicePaymentDeliveryService,
    private readonly catalog: VoicePaymentCatalogService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async sendPaymentLink(args: {
    email: string;
    variantId: string;
    quantity: number;
    phoneNumber?: string;
    tenantId?: string;
    agentId?: string;
  }): Promise<SendPaymentLinkResponseDto> {
    const started = Date.now();
    const email = args.email.trim().toLowerCase();
    const variantId = args.variantId.trim();
    const quantity = args.quantity;
    const phoneNumber = args.phoneNumber?.trim();

    this.logger.log(
      JSON.stringify({
        event: 'voice.payment.started',
        emailDomain: email.split('@')[1] ?? null,
        variantId: variantId.slice(0, 80),
        quantity,
        smsRequested: Boolean(phoneNumber),
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
            event: 'voice.payment.invoice_sent',
            tenantId,
            agentId,
            draftOrderId: shopify.draftOrderId,
            shopifyInvoiceSent: false,
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
      });

      let emailSentByShopify = shopify.shopifyInvoiceSent;
      let emailSentByResend = false;
      let smsSent = false;
      const warnings: string[] = [];

      const resend = await this.delivery.sendBrandedPaymentEmail({
        tenantId,
        agentId,
        checkoutLinkId: checkoutLink.id,
        email,
        invoiceUrl: shopify.invoiceUrl,
        lineItem,
      });
      if (resend.ok) {
        emailSentByResend = true;
        await this.prisma.checkoutLink.update({
          where: { id: checkoutLink.id },
          data: { status: 'SENT', sentAt: new Date() },
        });
        this.logger.log(
          JSON.stringify({
            event: 'voice.payment.resend_email_sent',
            tenantId,
            agentId,
            draftOrderId: shopify.draftOrderId,
            checkoutLinkId: checkoutLink.id,
            providerMessageId: resend.providerMessageId ?? null,
            emailDomain: email.split('@')[1] ?? null,
            productTitle: lineItem.title.slice(0, 120),
          }),
        );
      } else {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.payment.resend_email_failed',
            tenantId,
            agentId,
            draftOrderId: shopify.draftOrderId,
            checkoutLinkId: checkoutLink.id,
            message: resend.error?.slice(0, 300) ?? null,
          }),
        );
        if (resend.error) warnings.push(`Resend email failed: ${resend.error}`);
      }

      if (phoneNumber) {
        const sms = await this.delivery.sendSmsPaymentLink({
          phoneNumber,
          invoiceUrl: shopify.invoiceUrl,
          tenantId,
          agentId,
        });
        if (sms.ok) {
          smsSent = true;
          this.logger.log(
            JSON.stringify({
              event: 'voice.payment.sms_sent',
              tenantId,
              agentId,
              draftOrderId: shopify.draftOrderId,
              messageSid: sms.messageSid ?? null,
            }),
          );
        } else {
          this.logger.warn(
            JSON.stringify({
              event: 'voice.payment.sms_failed',
              tenantId,
              agentId,
              draftOrderId: shopify.draftOrderId,
              message: sms.error?.slice(0, 300) ?? null,
            }),
          );
          if (sms.error) warnings.push(`SMS failed: ${sms.error}`);
        }
      }

      const emailDelivered = emailSentByShopify || emailSentByResend;
      const latencyMs = Date.now() - started;

      if (!emailDelivered && !smsSent) {
        const error =
          'Payment link was created but email delivery failed on all channels. Please verify RESEND_API_KEY and PAYMENT_EMAIL_FROM, or provide phoneNumber for SMS.';
        this.logger.error(
          JSON.stringify({
            event: 'voice.payment.failed',
            tenantId,
            agentId,
            draftOrderId: shopify.draftOrderId,
            emailSentByShopify,
            emailSentByResend,
            smsSent,
            latencyMs,
            message: error,
          }),
        );
        return {
          success: false,
          message: 'Payment link could not be delivered.',
          error,
          draftOrderId: shopify.draftOrderId,
          invoiceUrl: shopify.invoiceUrl,
          emailSentByShopify,
          emailSentByResend,
          smsSent,
          latencyMs,
        };
      }

      if (emailSentByShopify && !emailSentByResend) {
        warnings.push('Backup Resend email was not delivered; customer may rely on Shopify invoice email.');
      } else if (!emailSentByShopify && emailSentByResend) {
        warnings.push('Shopify invoice email may not have been delivered; payment link sent via Resend.');
      }

      const warning = warnings.length > 0 ? warnings.join(' ') : undefined;

      this.logger.log(
        JSON.stringify({
          event: 'voice.payment.invoice_sent',
          tenantId,
          agentId,
          draftOrderId: shopify.draftOrderId,
          emailSentByShopify,
          emailSentByResend,
          smsSent,
          latencyMs,
          hasWarning: Boolean(warning),
        }),
      );

      return {
        success: true,
        message: warning
          ? 'Payment link sent with delivery warnings.'
          : 'Payment link sent successfully.',
        agentMessage: "I've sent the payment link to your email.",
        draftOrderId: shopify.draftOrderId,
        invoiceUrl: shopify.invoiceUrl,
        emailSentByShopify,
        emailSentByResend,
        smsSent,
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
        error: message,
        emailSentByShopify: false,
        emailSentByResend: false,
        smsSent: false,
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

    return this.prisma.checkoutLink.create({
      data: {
        tenantId: args.tenantId,
        agentId: args.agentId,
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
        } as Prisma.InputJsonValue,
      },
    });
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
