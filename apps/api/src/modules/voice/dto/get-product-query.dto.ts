import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** GET /api/voice/get-product — ElevenLabs SureShotBooksProductFetcher */
export class GetProductQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  query?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  isbn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  limit?: number;
}
