import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import type { PaymentEmailGateDebug } from '../utils/voice-payment-email-gate.util';

export class SendPaymentLinkDto {
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address.' })
  @MaxLength(320)
  email?: string;

  /** Optional when productName is provided — server can resolve via search-product. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  variantId?: string;

  /** Book title or search query — used to auto-resolve variantId when variantId is omitted. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  productName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  productQuery?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string;

  /** Alias for phoneNumber (some tool configs use `phone`). */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  /** Twilio CallSid — used to look up caller phone from `calls` table when phoneNumber is omitted. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  callSid?: string;

  /** Snake_case alias for callSid. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  call_sid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentId?: string;

  /** Must be true only after the customer verbally confirmed their email. */
  @IsOptional()
  @IsBoolean()
  emailConfirmed?: boolean;

  /** When true, create/send one aggregated invoice for all queued products on this call+email. */
  @IsOptional()
  @IsBoolean()
  finalizeCheckout?: boolean;
}

export type { PaymentEmailGateDebug };

export type SendPaymentLinkResponseDto = {
  success: boolean;
  message: string;
  /** Exact phrase the voice agent should speak after success. */
  agentMessage?: string;
  draftOrderId?: string;
  invoiceUrl?: string;
  emailSentByShopify?: boolean;
  emailSentByResend?: boolean;
  smsSent?: boolean;
  whatsappSent?: boolean;
  delivery?: {
    email: 'sent' | 'skipped' | 'failed';
    sms: 'sent' | 'skipped' | 'failed';
    whatsapp: 'sent' | 'skipped' | 'failed';
  };
  warning?: string;
  error?: string;
  /** PaymentDelivery row id (or no-db-* fallback) for support / log correlation. */
  deliveryAttemptId?: string | null;
  latencyMs?: number;
  /** Structured gate decision for logs / ElevenLabs tool debugging. */
  emailGate?: PaymentEmailGateDebug;
};
