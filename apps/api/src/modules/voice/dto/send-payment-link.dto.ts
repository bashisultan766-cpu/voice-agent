import { IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class SendPaymentLinkDto {
  @IsEmail({}, { message: 'email must be a valid email address.' })
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  variantId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentId?: string;
}

export type SendPaymentLinkResponseDto = {
  success: boolean;
  message: string;
  /** Exact phrase the voice agent should speak after success. */
  agentMessage?: string;
  draftOrderId?: string;
  invoiceUrl?: string;
  error?: string;
  latencyMs?: number;
};
