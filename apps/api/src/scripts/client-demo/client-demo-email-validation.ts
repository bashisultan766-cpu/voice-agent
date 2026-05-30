import type { INestApplicationContext } from '@nestjs/common';
import { EmailDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ResendEmailService } from '../../modules/integrations/email/resend-email.service';
import { AgentEmailConfigService } from '../../modules/integrations/email/agent-email-config.service';
import {
  assertPaymentEmailRecipientAllowed,
  parseClientDemoEmailAllowlist,
} from './client-demo-safety.util';
import {
  executeCommerceTool,
  readToolData,
} from './client-demo-commerce.util';
import type { ClientDemoEmailValidation } from './client-demo.types';

const SUCCESS_STATUSES = new Set<EmailDeliveryStatus>([
  EmailDeliveryStatus.SENT,
  EmailDeliveryStatus.DELIVERED,
  EmailDeliveryStatus.QUEUED,
  EmailDeliveryStatus.OPENED,
  EmailDeliveryStatus.CLICKED,
]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchResendEmailStatus(
  apiKey: string,
  messageId: string,
): Promise<{ ok: boolean; lastEvent?: string; error?: string }> {
  try {
    const res = await fetch(`https://api.resend.com/emails/${encodeURIComponent(messageId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: `Resend GET ${res.status}: ${text}` };
    }
    const body = (await res.json()) as { last_event?: string; status?: string };
    return { ok: true, lastEvent: body.last_event ?? body.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function validatePaymentEmailDelivery(
  app: INestApplicationContext,
  tenantId: string,
  agentId: string,
  opts: {
    recipient: string;
    checkoutLinkId: string;
    callSessionId?: string;
    skipSend?: boolean;
  },
): Promise<ClientDemoEmailValidation> {
  const errors: string[] = [];
  const recipient = opts.recipient.trim().toLowerCase();
  const allowlist = parseClientDemoEmailAllowlist();
  const allowlistEnforced = allowlist.size > 0;

  try {
    assertPaymentEmailRecipientAllowed(recipient);
  } catch (err) {
    return {
      pass: false,
      recipient,
      allowlistEnforced,
      emailSent: false,
      resendVerified: false,
      errors: [(err as Error).message],
    };
  }

  if (opts.skipSend) {
    return {
      pass: true,
      recipient,
      allowlistEnforced,
      emailSent: false,
      resendVerified: false,
      errors: [],
    };
  }

  const sendStarted = Date.now();
  const emailTool = await executeCommerceTool(app, tenantId, agentId, {
    callSessionId: opts.callSessionId,
    toolName: 'sendPaymentEmail',
    args: { email: recipient, checkoutLinkId: opts.checkoutLinkId },
  });
  const sendLatencyMs = Date.now() - sendStarted;

  if (!emailTool.result.ok) {
    errors.push(`sendPaymentEmail_failed:${emailTool.result.error?.message ?? 'unknown'}`);
    return {
      pass: false,
      recipient,
      allowlistEnforced,
      emailSent: false,
      sendLatencyMs,
      resendVerified: false,
      errors,
    };
  }

  const data = readToolData(emailTool.result);
  const emailEventId =
    typeof data.emailEventId === 'string' ? data.emailEventId : undefined;
  const providerMessageId =
    typeof data.providerMessageId === 'string' ? data.providerMessageId : undefined;

  const prisma = app.get(PrismaService);
  const pollMs = Number(process.env.CLIENT_DEMO_EMAIL_POLL_MS) || 2000;
  const maxPolls = Number(process.env.CLIENT_DEMO_EMAIL_POLL_MAX) || 15;
  let deliveryStatus: string | undefined;
  let deliveryLatencyMs: number | undefined;
  const deliveryStarted = Date.now();

  for (let i = 0; i < maxPolls; i++) {
    const row = emailEventId
      ? await prisma.emailEvent.findFirst({ where: { id: emailEventId, tenantId } })
      : await prisma.emailEvent.findFirst({
          where: {
            tenantId,
            checkoutLinkId: opts.checkoutLinkId,
            recipientEmail: recipient,
          },
          orderBy: { createdAt: 'desc' },
        });

    if (row && SUCCESS_STATUSES.has(row.status)) {
      deliveryStatus = row.status;
      deliveryLatencyMs = Date.now() - deliveryStarted;
      break;
    }
    if (row?.status === EmailDeliveryStatus.FAILED || row?.status === EmailDeliveryStatus.BOUNCED) {
      deliveryStatus = row.status;
      errors.push(`email_delivery_${row.status}`);
      break;
    }
    await sleep(pollMs);
  }

  if (!deliveryStatus) {
    errors.push('email_delivery_timeout');
  }

  let resendVerified = false;
  const emailConfig = app.get(AgentEmailConfigService);
  const resolved = await emailConfig.resolveForSend(tenantId, agentId);
  const resendKey = resolved?.apiKey?.trim();
  const msgId = providerMessageId;

  if (resendKey && msgId) {
    const resend = await fetchResendEmailStatus(resendKey, msgId);
    resendVerified = resend.ok;
    if (!resend.ok && resend.error) {
      errors.push(`resend_status_poll:${resend.error}`);
    } else if (resend.lastEvent) {
      resendVerified = true;
    }
  } else {
    // DB status is sufficient when Resend message id unavailable
    resendVerified = Boolean(deliveryStatus && SUCCESS_STATUSES.has(deliveryStatus as EmailDeliveryStatus));
  }

  const pass =
    errors.length === 0 &&
    Boolean(deliveryStatus) &&
    SUCCESS_STATUSES.has(deliveryStatus as EmailDeliveryStatus);

  return {
    pass,
    recipient,
    allowlistEnforced,
    emailSent: true,
    emailEventId,
    deliveryStatus,
    providerMessageId: msgId,
    resendVerified,
    sendLatencyMs,
    deliveryLatencyMs,
    errors,
  };
}

/** Sends a real payment email via ResendEmailService (ops-style) when checkout URL is known. */
export async function sendRealPaymentEmail(
  app: INestApplicationContext,
  tenantId: string,
  agentId: string,
  opts: {
    recipient: string;
    checkoutLinkId: string;
    checkoutUrl: string;
    callSessionId?: string;
    items: Array<{ title: string; quantity: number; price?: string | null }>;
  },
): Promise<{ emailEventId: string; providerMessageId: string | null }> {
  assertPaymentEmailRecipientAllowed(opts.recipient);

  const prisma = app.get(PrismaService);
  const resend = app.get(ResendEmailService);
  const emailConfig = app.get(AgentEmailConfigService);

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, tenantId, deletedAt: null },
    include: { agentConfig: true },
  });
  if (!agent) throw new Error('Agent not found');

  const resolvedEmail = await emailConfig.resolveForSend(tenantId, agentId);
  const proof = await resend.sendPaymentEmail({
    tenantId,
    agentId,
    callSessionId: opts.callSessionId,
    checkoutLinkId: opts.checkoutLinkId,
    to: opts.recipient,
    businessName: agent.agentConfig?.businessName?.trim() || agent.name,
    supportEmail: agent.agentConfig?.supportEmail,
    supportPhone: agent.agentConfig?.supportPhone,
    checkoutUrl: opts.checkoutUrl,
    items: opts.items,
    emailConfig: resolvedEmail,
  });

  return {
    emailEventId: proof.emailEventId,
    providerMessageId: proof.providerMessageId,
  };
}
