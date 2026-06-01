import { IsEmail, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class TestDeliveryDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(2048)
  paymentLink!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  callSid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentId?: string;
}
