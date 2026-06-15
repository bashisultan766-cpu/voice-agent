import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { sanitizeCustomerFacingText } from '../utils/voice-agent-language.util';

export type EscalationReason =
  | 'book_not_listed'
  | 'unknown_inventory'
  | 'facility_approval_unknown'
  | 'restricted_book'
  | 'cancellation_needs_staff'
  | 'address_update'
  | 'customer_requests_human'
  | 'call_cutoff'
  | 'tool_failure'
  | string;

export type EscalationResult = {
  success: boolean;
  escalation_id: string;
  reason: string;
  customer_message: string;
  suggested_response: string;
  support_email: string | null;
};

const ESCALATION_MESSAGES: Record<string, string> = {
  book_not_listed:
    'I will connect you with customer service to check whether we can source that title.',
  unknown_inventory:
    'I need customer service to confirm inventory. I will have our team follow up with you.',
  facility_approval_unknown:
    'I will have customer service verify whether we can ship to that facility.',
  restricted_book:
    'One or more books on your order need review. Customer service will help you with options.',
  cancellation_needs_staff:
    'I will submit your cancellation request to customer service for processing.',
  address_update:
    'For address changes, customer service will assist after you email the correct details.',
  customer_requests_human:
    'I will connect you with a customer service representative.',
  call_cutoff:
    'I am sorry the call was interrupted. Customer service can follow up with you.',
  tool_failure:
    'I am having trouble accessing our systems. Customer service will assist you shortly.',
};

@Injectable()
export class VoiceEscalationService {
  private readonly logger = new Logger(VoiceEscalationService.name);

  constructor(private readonly config: ConfigService) {}

  escalate(args: {
    reason: EscalationReason;
    summary?: string;
    orderNumber?: string;
    callerPhone?: string;
    callSid?: string;
  }): EscalationResult {
    const escalationId = `esc_${randomUUID().slice(0, 12)}`;
    const reason = args.reason?.trim() || 'customer_requests_human';
    const supportEmail =
      this.config.get<string>('CUSTOMER_SERVICE_EMAIL')?.trim() ||
      this.config.get<string>('JESSICA_SUPPORT_EMAIL')?.trim() ||
      null;

    const baseMessage =
      ESCALATION_MESSAGES[reason] ??
      'I will connect you with customer service to help with your request.';

    const customerMessage = sanitizeCustomerFacingText(baseMessage);

    this.logger.log(
      JSON.stringify({
        event: 'voice.escalation.created',
        escalationId,
        reason,
        orderNumber: args.orderNumber?.slice(0, 32) ?? null,
        callSid: args.callSid ?? null,
        summaryPreview: args.summary?.slice(0, 200) ?? null,
        callerPhoneMasked: args.callerPhone ? maskPhone(args.callerPhone) : null,
      }),
    );

    if (supportEmail) {
      this.logger.log(
        JSON.stringify({
          event: 'voice.escalation.email_queued',
          escalationId,
          supportEmail: maskEmail(supportEmail),
          note: 'Escalation logged — wire Resend in production if ticket email is required.',
        }),
      );
    }

    return {
      success: true,
      escalation_id: escalationId,
      reason,
      customer_message: customerMessage,
      suggested_response: customerMessage,
      support_email: supportEmail,
    };
  }
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}
