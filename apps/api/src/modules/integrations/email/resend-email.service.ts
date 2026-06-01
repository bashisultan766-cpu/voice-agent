import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '@prisma/client';
import { buildPaymentEmailContent } from './payment-email-templates';
import { PaymentEmailSubjectService } from './payment-email-subject.service';
import { paymentEmailIdempotencyKey } from '../../../common/payment-email-idempotency';
import { assertPaymentEmailRecipientAllowed } from '../../../common/client-demo-safety.util';
import type { ResolvedAgentEmailConfig } from './agent-email-config.service';

function assertHttpsCheckoutUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid checkout URL.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Checkout URL must use HTTPS.');
  }
  return url.toString();
}

const RESEND_MAX_ATTEMPTS = Math.min(Math.max(Number(process.env.RESEND_MAX_ATTEMPTS) || 5, 1), 10);
const RESEND_RETRY_BASE_MS = Math.max(Number(process.env.RESEND_RETRY_BASE_MS) || 500, 100);

const SUCCESS_STATUSES = new Set(['SENT', 'DELIVERED', 'OPENED', 'CLICKED']);
const STALE_QUEUED_MS = Math.max(Number(process.env.PAYMENT_EMAIL_STALE_QUEUED_MS) || 10 * 60 * 1000, 60_000);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientSendFailure(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function appendSendAttempt(metadata: unknown, attempt: Record<string, unknown>): Prisma.InputJsonValue {
  const base =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  const prev = base.attempts;
  const attempts = Array.isArray(prev) ? [...prev] : [];
  attempts.push(attempt);
  return { ...base, attempts } as Prisma.InputJsonValue;
}

export type PaymentEmailDeliveryProof = {
  success: boolean;
  smtpAccepted: boolean;
  providerSuccess: boolean;
  deliveryQueued: boolean;
  providerMessageId: string | null;
  emailEventId: string;
  deduplicated?: boolean;
};

type SendPaymentEmailResult = PaymentEmailDeliveryProof;

@Injectable()
export class ResendEmailService {
  private readonly logger = new Logger(ResendEmailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly paymentEmailSubject: PaymentEmailSubjectService,
  ) {}

  private apiKey(override?: string): string {
    const key = override?.trim();
    if (!key) {
      throw new Error(
        'Resend API key is not configured for this agent. Add resendApiKey in the agent form (or enable workspace email with a saved workspace key).',
      );
    }
    return key;
  }

  async sendPaymentEmail(input: {
    tenantId: string;
    agentId: string;
    callSessionId?: string;
    checkoutLinkId: string;
    /** Successful sends dedupe; FAILED / QUEUED / BOUNCED rows retry in-place with the same key. */
    idempotencyKey?: string;
    to: string;
    businessName: string;
    supportEmail?: string | null;
    supportPhone?: string | null;
    checkoutUrl: string;
    items: Array<{ title: string; quantity: number; price?: string | null }>;
    /** Per-agent resolved email config (never log these values). */
    emailConfig?: ResolvedAgentEmailConfig | null;
  }): Promise<SendPaymentEmailResult> {
    const safeCheckoutUrl = assertHttpsCheckoutUrl(input.checkoutUrl.trim());
    const cleanTo = input.to.trim().toLowerCase();
    if (!cleanTo.includes('@')) {
      throw new Error('A valid customer email is required.');
    }
    assertPaymentEmailRecipientAllowed(cleanTo);

    const subjectResolution = this.paymentEmailSubject.getPaymentLinkSubject({
      businessName: input.businessName,
      subjectTemplate: input.emailConfig?.subjectTemplate,
    });

    const tmpl = buildPaymentEmailContent({
      businessName: input.businessName.trim() || 'Our store',
      supportEmail: input.supportEmail,
      supportPhone: input.supportPhone,
      checkoutUrl: safeCheckoutUrl,
      items: input.items,
      subject: subjectResolution.subject,
      customIntro: input.emailConfig?.paymentLinkIntro,
    });

    const idemKey =
      input.idempotencyKey?.trim() ||
      paymentEmailIdempotencyKey({
        tenantId: input.tenantId,
        agentId: input.agentId,
        checkoutLinkId: input.checkoutLinkId,
        recipientEmail: cleanTo,
        purpose: 'payment_email.implicit',
      });

    const txResult = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.emailEvent.findFirst({
          where: { tenantId: input.tenantId, idempotencyKey: idemKey },
        });
        if (existing) {
          if (SUCCESS_STATUSES.has(existing.status)) {
            return {
              kind: 'dedup' as const,
              duplicate: existing,
              dedupReason: 'idempotency_key' as const,
            };
          }
          if (existing.status === 'FAILED' || existing.status === 'BOUNCED') {
            const row = await tx.emailEvent.update({
              where: { id: existing.id },
              data: {
                status: 'QUEUED',
                checkoutLinkId: input.checkoutLinkId,
                callSessionId: input.callSessionId ?? null,
                agentId: input.agentId,
                recipientEmail: cleanTo,
                subject: tmpl.subject,
                bodyPreview: tmpl.bodyPreview,
              },
            });
            return { kind: 'send' as const, row };
          }
          if (existing.status === 'QUEUED') {
            const age = Date.now() - existing.updatedAt.getTime();
            if (age <= STALE_QUEUED_MS) {
              return { kind: 'in_flight' as const, existing };
            }
            const row = await tx.emailEvent.update({
              where: { id: existing.id },
              data: {
                checkoutLinkId: input.checkoutLinkId,
                callSessionId: input.callSessionId ?? null,
                agentId: input.agentId,
                recipientEmail: cleanTo,
                subject: tmpl.subject,
                bodyPreview: tmpl.bodyPreview,
              },
            });
            return { kind: 'send' as const, row };
          }
        }

        const duplicate = await tx.emailEvent.findFirst({
          where: {
            tenantId: input.tenantId,
            agentId: input.agentId,
            checkoutLinkId: input.checkoutLinkId,
            recipientEmail: cleanTo,
            status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'QUEUED'] },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (duplicate) {
          if (duplicate.status === 'QUEUED') {
            const age = Date.now() - duplicate.updatedAt.getTime();
            if (age <= STALE_QUEUED_MS) {
              return { kind: 'in_flight' as const, existing: duplicate };
            }
            const row = await tx.emailEvent.update({
              where: { id: duplicate.id },
              data: {
                idempotencyKey: idemKey,
                callSessionId: input.callSessionId ?? null,
                recipientEmail: cleanTo,
                subject: tmpl.subject,
                bodyPreview: tmpl.bodyPreview,
              },
            });
            return { kind: 'send' as const, row };
          }
          return { kind: 'dedup' as const, duplicate, dedupReason: 'checkout_recipient' as const };
        }

        const row = await tx.emailEvent.create({
          data: {
            tenantId: input.tenantId,
            agentId: input.agentId,
            callSessionId: input.callSessionId ?? null,
            checkoutLinkId: input.checkoutLinkId,
            idempotencyKey: idemKey,
            recipientEmail: cleanTo,
            subject: tmpl.subject,
            provider: 'resend',
            status: 'QUEUED',
            bodyPreview: tmpl.bodyPreview,
          },
        });
        return { kind: 'send' as const, row };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5000,
        timeout: 20000,
      },
    );

    if (txResult.kind === 'in_flight') {
      this.logger.warn(
        JSON.stringify({
          event: 'payment_email.in_flight',
          tenantId: input.tenantId,
          checkoutLinkId: input.checkoutLinkId,
          emailEventId: txResult.existing.id,
        }),
      );
      await this.prisma.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action: 'CHECKOUT_EMAIL_IN_FLIGHT',
          entityType: 'CHECKOUT_LINK',
          entityId: input.checkoutLinkId,
          metadata: {
            emailEventId: txResult.existing.id,
            recipientEmail: cleanTo.replace(/^(.).+(@.*)$/, '$1***$2'),
          } as Prisma.InputJsonValue,
        },
      });
      throw new Error(
        'A payment email is already being sent for this checkout. Please wait a few seconds and try again.',
      );
    }

    if (txResult.kind === 'dedup') {
      this.logger.log(
        JSON.stringify({
          event: 'payment_email.deduplicated',
          tenantId: input.tenantId,
          agentId: input.agentId,
          checkoutLinkId: input.checkoutLinkId,
          emailEventId: txResult.duplicate.id,
          reason: txResult.dedupReason,
          recipientEmailMasked: cleanTo.replace(/^(.).+(@.*)$/, '$1***$2'),
        }),
      );
      await this.prisma.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action: 'CHECKOUT_EMAIL_DEDUPLICATED',
          entityType: 'CHECKOUT_LINK',
          entityId: input.checkoutLinkId,
          metadata: {
            emailEventId: txResult.duplicate.id,
            reason: txResult.dedupReason,
            recipientEmail: cleanTo.replace(/^(.).+(@.*)$/, '$1***$2'),
          } as Prisma.InputJsonValue,
        },
      });
      return {
        success: true,
        smtpAccepted: true,
        providerSuccess: true,
        deliveryQueued: true,
        emailEventId: txResult.duplicate.id,
        providerMessageId: txResult.duplicate.providerMessageId ?? null,
        deduplicated: true,
      };
    }

    const emailRow = txResult.row;
    const emailEventId = emailRow.id;

    const from =
      input.emailConfig?.from?.trim() || this.config.get<string>('RESEND_FROM_EMAIL')?.trim();
    if (!from) {
      const configMsg = 'Email sender address is not configured for this agent.';
      this.logger.error(
        JSON.stringify({
          event: 'payment_email.send_config_error',
          tenantId: input.tenantId,
          agentId: input.agentId,
          checkoutLinkId: input.checkoutLinkId,
          emailEventId,
          message: configMsg,
        }),
      );
      await this.prisma.emailEvent.update({
        where: { id: emailEventId },
        data: {
          status: 'FAILED',
          metadata: appendSendAttempt(emailRow.metadata, {
            at: new Date().toISOString(),
            outcome: 'config_error',
            message: configMsg,
          }),
        },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action: 'CHECKOUT_EMAIL_FAILED',
          entityType: 'CHECKOUT_LINK',
          entityId: input.checkoutLinkId,
          metadata: {
            emailEventId,
            recipientEmail: cleanTo.replace(/^(.).+(@.*)$/, '$1***$2'),
            message: configMsg,
          } as Prisma.InputJsonValue,
        },
      });
      throw new Error(configMsg);
    }
    const replyTo = input.emailConfig?.replyTo?.trim();

    let lastPayload: { id?: string; message?: string } = {};
    let lastStatus = 0;

    for (let attempt = 1; attempt <= RESEND_MAX_ATTEMPTS; attempt++) {
      this.logger.log(
        JSON.stringify({
          event: 'payment_email.send_attempt',
          tenantId: input.tenantId,
          agentId: input.agentId,
          checkoutLinkId: input.checkoutLinkId,
          emailEventId,
          attempt,
          maxAttempts: RESEND_MAX_ATTEMPTS,
          recipientEmailMasked: cleanTo.replace(/^(.).+(@.*)$/, '$1***$2'),
        }),
      );

      try {
        const payload: Record<string, unknown> = {
          from,
          to: [cleanTo],
          subject: tmpl.subject,
          html: tmpl.html,
          text: tmpl.text,
        };
        if (replyTo) payload.reply_to = replyTo;

        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey(input.emailConfig?.apiKey)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        lastStatus = response.status;
        lastPayload = (await response.json().catch(() => ({}))) as { id?: string; message?: string };

        if (response.ok) {
          const metaRow = await this.prisma.emailEvent.findUniqueOrThrow({ where: { id: emailEventId } });
          this.logger.log(
            JSON.stringify({
              event: 'payment_email.send_success',
              tenantId: input.tenantId,
              agentId: input.agentId,
              checkoutLinkId: input.checkoutLinkId,
              emailEventId,
              attempt,
              providerMessageId: lastPayload.id ?? null,
            }),
          );
          await this.prisma.emailEvent.update({
            where: { id: emailEventId },
            data: {
              status: 'SENT',
              providerMessageId: lastPayload.id ?? null,
              metadata: appendSendAttempt(metaRow.metadata, {
                at: new Date().toISOString(),
                attempt,
                outcome: 'sent',
                httpStatus: response.status,
                providerMessageId: lastPayload.id ?? null,
              }),
              sentAt: new Date(),
            },
          });
          await this.prisma.auditLog.create({
            data: {
              tenantId: input.tenantId,
              action: 'CHECKOUT_EMAIL_SENT',
              entityType: 'CHECKOUT_LINK',
              entityId: input.checkoutLinkId,
              metadata: {
                emailEventId,
                attempt,
                recipientEmail: cleanTo.replace(/^(.).+(@.*)$/, '$1***$2'),
              } as Prisma.InputJsonValue,
            },
          });
          this.logger.log(
            JSON.stringify({
              event: 'payment_email.delivery_confirmed',
              tenantId: input.tenantId,
              agentId: input.agentId,
              checkoutLinkId: input.checkoutLinkId,
              emailEventId,
              providerMessageId: lastPayload.id ?? null,
              smtpAccepted: true,
              providerSuccess: true,
              deliveryQueued: true,
            }),
          );
          return {
            success: true,
            smtpAccepted: true,
            providerSuccess: true,
            deliveryQueued: true,
            emailEventId,
            providerMessageId: lastPayload.id ?? null,
          };
        }

        const transient = isTransientSendFailure(response.status);
        const metaRow = await this.prisma.emailEvent.findUniqueOrThrow({ where: { id: emailEventId } });
        await this.prisma.emailEvent.update({
          where: { id: emailEventId },
          data: {
            metadata: appendSendAttempt(metaRow.metadata, {
              at: new Date().toISOString(),
              attempt,
              outcome: transient ? 'error_transient' : 'error_terminal',
              httpStatus: response.status,
              message: (lastPayload.message || `HTTP ${response.status}`).slice(0, 500),
            }),
          },
        });

        this.logger.warn(
          JSON.stringify({
            event: 'payment_email.send_attempt_failed',
            tenantId: input.tenantId,
            agentId: input.agentId,
            checkoutLinkId: input.checkoutLinkId,
            emailEventId,
            attempt,
            httpStatus: response.status,
            transient,
            message: (lastPayload.message || '').slice(0, 200),
          }),
        );

        if (!transient || attempt === RESEND_MAX_ATTEMPTS) {
          break;
        }
        const jitter = Math.floor(Math.random() * 150);
        await sleep(RESEND_RETRY_BASE_MS * 2 ** (attempt - 1) + jitter);
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 400) : 'network_error';
        const metaRow = await this.prisma.emailEvent.findUniqueOrThrow({ where: { id: emailEventId } });
        await this.prisma.emailEvent.update({
          where: { id: emailEventId },
          data: {
            metadata: appendSendAttempt(metaRow.metadata, {
              at: new Date().toISOString(),
              attempt,
              outcome: 'network_error',
              message,
            }),
          },
        });
        this.logger.warn(
          JSON.stringify({
            event: 'payment_email.send_network_error',
            tenantId: input.tenantId,
            agentId: input.agentId,
            checkoutLinkId: input.checkoutLinkId,
            emailEventId,
            attempt,
            message: message.slice(0, 200),
          }),
        );
        if (attempt === RESEND_MAX_ATTEMPTS) break;
        const jitter = Math.floor(Math.random() * 150);
        await sleep(RESEND_RETRY_BASE_MS * 2 ** (attempt - 1) + jitter);
      }
    }

    const failMessage = lastPayload.message || `Failed to send payment email (HTTP ${lastStatus || 'n/a'}).`;
    const metaFinal = await this.prisma.emailEvent.findUniqueOrThrow({ where: { id: emailEventId } });
    await this.prisma.emailEvent.update({
      where: { id: emailEventId },
      data: {
        status: 'FAILED',
        metadata: appendSendAttempt(metaFinal.metadata, {
          at: new Date().toISOString(),
          outcome: 'failed_final',
          message: failMessage.slice(0, 500),
        }),
      },
    });

    this.logger.error(
      JSON.stringify({
        event: 'payment_email.send_failed_final',
        tenantId: input.tenantId,
        agentId: input.agentId,
        checkoutLinkId: input.checkoutLinkId,
        emailEventId,
        httpStatus: lastStatus,
        message: failMessage.slice(0, 300),
      }),
    );

    await this.prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: 'CHECKOUT_EMAIL_FAILED',
        entityType: 'CHECKOUT_LINK',
        entityId: input.checkoutLinkId,
        metadata: {
          emailEventId,
          recipientEmail: cleanTo.replace(/^(.).+(@.*)$/, '$1***$2'),
          httpStatus: lastStatus,
          message: failMessage.slice(0, 300),
        } as Prisma.InputJsonValue,
      },
    });

    throw new Error(failMessage);
  }
}
