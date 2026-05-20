import { IsOptional, IsString, IsNumber, Min, Max, IsEnum } from 'class-validator';
import { CallResolutionStatus } from '@prisma/client';

export class UpdateCallOutcomeDto {
  @IsOptional()
  @IsEnum(CallResolutionStatus)
  resolutionStatus?: CallResolutionStatus;

  @IsOptional()
  @IsString()
  primaryIntent?: string;

  @IsOptional()
  @IsString()
  secondaryIntent?: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  qaScore?: number;
}
