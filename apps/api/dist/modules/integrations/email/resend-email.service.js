"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var ResendEmailService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResendEmailService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../../database/prisma.service");
const client_1 = require("@prisma/client");
const payment_email_templates_1 = require("./payment-email-templates");
const payment_email_idempotency_1 = require("../../../common/payment-email-idempotency");
const client_demo_safety_util_1 = require("../../../common/client-demo-safety.util");
function assertHttpsCheckoutUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
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
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function isTransientSendFailure(status) {
    return status === 408 || status === 429 || status >= 500;
}
function appendSendAttempt(metadata, attempt) {
    const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { ...metadata }
        : {};
    const prev = base.attempts;
    const attempts = Array.isArray(prev) ? [...prev] : [];
    attempts.push(attempt);
    return { ...base, attempts };
}
let ResendEmailService = ResendEmailService_1 = class ResendEmailService {
    constructor(config, prisma) {
        this.config = config;
        this.prisma = prisma;
        this.logger = new common_1.Logger(ResendEmailService_1.name);
    }
    apiKey(override) {
        const key = override?.trim();
        if (!key) {
            throw new Error('Resend API key is not configured for this agent. Add resendApiKey in the agent form (or enable workspace email with a saved workspace key).');
        }
        return key;
    }
    async sendPaymentEmail(input) {
        const safeCheckoutUrl = assertHttpsCheckoutUrl(input.checkoutUrl.trim());
        const cleanTo = input.to.trim().toLowerCase();
        if (!cleanTo.includes('@')) {
            throw new Error('A valid customer email is required.');
        }
        (0, client_demo_safety_util_1.assertPaymentEmailRecipientAllowed)(cleanTo);
        const tmpl = (0, payment_email_templates_1.buildPaymentEmailContent)({
            businessName: input.businessName.trim() || 'Our store',
            supportEmail: input.supportEmail,
            supportPhone: input.supportPhone,
            checkoutUrl: safeCheckoutUrl,
            items: input.items,
            subjectTemplate: input.emailConfig?.subjectTemplate,
            customIntro: input.emailConfig?.paymentLinkIntro,
        });
        const idemKey = input.idempotencyKey?.trim() ||
            (0, payment_email_idempotency_1.paymentEmailIdempotencyKey)({
                tenantId: input.tenantId,
                agentId: input.agentId,
                checkoutLinkId: input.checkoutLinkId,
                recipientEmail: cleanTo,
                purpose: 'payment_email.implicit',
            });
        const txResult = await this.prisma.$transaction(async (tx) => {
            const existing = await tx.emailEvent.findFirst({
                where: { tenantId: input.tenantId, idempotencyKey: idemKey },
            });
            if (existing) {
                if (SUCCESS_STATUSES.has(existing.status)) {
                    return {
                        kind: 'dedup',
                        duplicate: existing,
                        dedupReason: 'idempotency_key',
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
                    return { kind: 'send', row };
                }
                if (existing.status === 'QUEUED') {
                    const age = Date.now() - existing.updatedAt.getTime();
                    if (age <= STALE_QUEUED_MS) {
                        return { kind: 'in_flight', existing };
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
                    return { kind: 'send', row };
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
                        return { kind: 'in_flight', existing: duplicate };
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
                    return { kind: 'send', row };
                }
                return { kind: 'dedup', duplicate, dedupReason: 'checkout_recipient' };
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
            return { kind: 'send', row };
        }, {
            isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5000,
            timeout: 20000,
        });
        if (txResult.kind === 'in_flight') {
            this.logger.warn(JSON.stringify({
                event: 'payment_email.in_flight',
                tenantId: input.tenantId,
                checkoutLinkId: input.checkoutLinkId,
                emailEventId: txResult.existing.id,
            }));
            await this.prisma.auditLog.create({
                data: {
                    tenantId: input.tenantId,
                    action: 'CHECKOUT_EMAIL_IN_FLIGHT',
                    entityType: 'CHECKOUT_LINK',
                    entityId: input.checkoutLinkId,
                    metadata: {
                        emailEventId: txResult.existing.id,
                        recipientEmail: cleanTo.replace(/^(.).+(@.*)$/, '$1***$2'),
                    },
                },
            });
            throw new Error('A payment email is already being sent for this checkout. Please wait a few seconds and try again.');
        }
        if (txResult.kind === 'dedup') {
            this.logger.log(JSON.stringify({
                event: 'payment_email.deduplicated',
                tenantId: input.tenantId,
                agentId: input.agentId,
                checkoutLinkId: input.checkoutLinkId,
                emailEventId: txResult.duplicate.id,
                reason: txResult.dedupReason,
                recipientEmailMasked: cleanTo.replace(/^(.).+(@.*)$/, '$1***$2'),
            }));
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
                    },
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
        const from = input.emailConfig?.from?.trim() || this.config.get('RESEND_FROM_EMAIL')?.trim();
        if (!from) {
            const configMsg = 'Email sender address is not configured for this agent.';
            this.logger.error(JSON.stringify({
                event: 'payment_email.send_config_error',
                tenantId: input.tenantId,
                agentId: input.agentId,
                checkoutLinkId: input.checkoutLinkId,
                emailEventId,
                message: configMsg,
            }));
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
                    },
                },
            });
            throw new Error(configMsg);
        }
        const replyTo = input.emailConfig?.replyTo?.trim();
        let lastPayload = {};
        let lastStatus = 0;
        for (let attempt = 1; attempt <= RESEND_MAX_ATTEMPTS; attempt++) {
            this.logger.log(JSON.stringify({
                event: 'payment_email.send_attempt',
                tenantId: input.tenantId,
                agentId: input.agentId,
                checkoutLinkId: input.checkoutLinkId,
                emailEventId,
                attempt,
                maxAttempts: RESEND_MAX_ATTEMPTS,
                recipientEmailMasked: cleanTo.replace(/^(.).+(@.*)$/, '$1***$2'),
            }));
            try {
                const payload = {
                    from,
                    to: [cleanTo],
                    subject: tmpl.subject,
                    html: tmpl.html,
                    text: tmpl.text,
                };
                if (replyTo)
                    payload.reply_to = replyTo;
                const response = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey(input.emailConfig?.apiKey)}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                });
                lastStatus = response.status;
                lastPayload = (await response.json().catch(() => ({})));
                if (response.ok) {
                    const metaRow = await this.prisma.emailEvent.findUniqueOrThrow({ where: { id: emailEventId } });
                    this.logger.log(JSON.stringify({
                        event: 'payment_email.send_success',
                        tenantId: input.tenantId,
                        agentId: input.agentId,
                        checkoutLinkId: input.checkoutLinkId,
                        emailEventId,
                        attempt,
                        providerMessageId: lastPayload.id ?? null,
                    }));
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
                            },
                        },
                    });
                    this.logger.log(JSON.stringify({
                        event: 'payment_email.delivery_confirmed',
                        tenantId: input.tenantId,
                        agentId: input.agentId,
                        checkoutLinkId: input.checkoutLinkId,
                        emailEventId,
                        providerMessageId: lastPayload.id ?? null,
                        smtpAccepted: true,
                        providerSuccess: true,
                        deliveryQueued: true,
                    }));
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
                this.logger.warn(JSON.stringify({
                    event: 'payment_email.send_attempt_failed',
                    tenantId: input.tenantId,
                    agentId: input.agentId,
                    checkoutLinkId: input.checkoutLinkId,
                    emailEventId,
                    attempt,
                    httpStatus: response.status,
                    transient,
                    message: (lastPayload.message || '').slice(0, 200),
                }));
                if (!transient || attempt === RESEND_MAX_ATTEMPTS) {
                    break;
                }
                const jitter = Math.floor(Math.random() * 150);
                await sleep(RESEND_RETRY_BASE_MS * 2 ** (attempt - 1) + jitter);
            }
            catch (err) {
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
                this.logger.warn(JSON.stringify({
                    event: 'payment_email.send_network_error',
                    tenantId: input.tenantId,
                    agentId: input.agentId,
                    checkoutLinkId: input.checkoutLinkId,
                    emailEventId,
                    attempt,
                    message: message.slice(0, 200),
                }));
                if (attempt === RESEND_MAX_ATTEMPTS)
                    break;
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
        this.logger.error(JSON.stringify({
            event: 'payment_email.send_failed_final',
            tenantId: input.tenantId,
            agentId: input.agentId,
            checkoutLinkId: input.checkoutLinkId,
            emailEventId,
            httpStatus: lastStatus,
            message: failMessage.slice(0, 300),
        }));
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
                },
            },
        });
        throw new Error(failMessage);
    }
};
exports.ResendEmailService = ResendEmailService;
exports.ResendEmailService = ResendEmailService = ResendEmailService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        prisma_service_1.PrismaService])
], ResendEmailService);
//# sourceMappingURL=resend-email.service.js.map